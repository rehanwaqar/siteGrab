import fsp from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import { formatCapturedCode } from './formatter.ts';
import { normalizeAndRepairGeneratedFiles } from './generatedSiteRepair.ts';
import { isRetryableAiError, safeParseModelJson } from './jsonUtils.ts';
import type { CaptureJob, CaptureStats } from './types.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

export const MAX_UPLOAD_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB

export class ScreenshotGenError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ScreenshotGenError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function detectImageMimeType(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // WEBP: RIFF....WEBP
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  // GIF: GIF87a or GIF89a
  const hdr6 = buf.toString('ascii', 0, 6);
  if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') {
    return 'image/gif';
  }
  return null;
}

let sharedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new ScreenshotGenError(
      503,
      'AI_UNCONFIGURED',
      'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets.',
    );
  }
  if (!sharedClient) {
    sharedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return sharedClient;
}

interface GeneratedFileSpec {
  filePath: string;
  content: string;
}

interface GeneratedSitePayload {
  siteTitle: string;
  summary: string;
  files: GeneratedFileSpec[];
}

export async function generateWebsiteFromScreenshot(options: {
  imageBuffer: Buffer;
  originalFilename: string;
  notes?: string;
  job: CaptureJob;
  stats: CaptureStats;
}): Promise<void> {
  const { imageBuffer, originalFilename, notes, job, stats } = options;
  const startTime = Date.now();

  if (!imageBuffer || imageBuffer.length === 0) {
    throw new ScreenshotGenError(
      400,
      'INVALID_IMAGE',
      'No screenshot image received. Please upload a PNG, JPEG, WebP, or GIF image.',
    );
  }
  if (imageBuffer.length > MAX_UPLOAD_SCREENSHOT_BYTES) {
    throw new ScreenshotGenError(
      413,
      'SIZE_LIMIT_EXCEEDED',
      'Uploaded screenshot exceeds the 10 MB limit.',
    );
  }

  const mimeType = detectImageMimeType(imageBuffer);
  if (!mimeType) {
    throw new ScreenshotGenError(
      400,
      'INVALID_IMAGE',
      'Unsupported image file. Please upload a valid PNG, JPEG, WebP, or GIF screenshot.',
    );
  }

  const ai = getGeminiClient();

  const systemInstruction = [
    'You are a principal frontend engineer converting a website/UI screenshot into a PIXEL-FAITHFUL, ACCURATE, RESPONSIVE, FULLY FUNCTIONAL web application project.',
    'VISUAL & CONTENT ACCURACY RULES:',
    '1. Transcribe EVERY visible section, brand logo/title, header or sidebar navigation item, hero headline/copy, KPI/metric numbers, table columns/rows, card titles/prices/descriptions, status badges, search/filter bars, inputs, footer columns, and action buttons faithfully from the screenshot.',
    '2. Match the EXACT visual theme (light vs dark background), background/surface/border/text/accent hex colors in :root CSS custom properties, typography hierarchy, card grid proportions, border radii, shadows, and alignment shown in the screenshot.',
    '3. Where charts, illustrations, avatars, or product visuals appear in the screenshot, render crisp matching local SVGs in "./assets/images/*.svg" or inline SVGs — NEVER use external image URLs or CDN links.',
    'COMPLETE WORKING APPLICATION MECHANICS (UNIFIED SPA + ZERO DEAD BUTTONS):',
    '4. Build interactive web apps as a UNIFIED SINGLE-PAGE APPLICATION inside "index.html" + "css/styles.css" + "js/main.js" using `data-view` / `#hash` view-switching so state, playback, cart, and Sign In session persist cleanly without resets. NEVER leave decorative or dead buttons, placeholder stubs, or "coming soon" sections. Audit EVERY visible control and wire it in "js/main.js" with "localStorage" persistence:',
    '   - Header & chrome buttons: Hamburger menu/sidebar toggle, search submit + clear, Create/Upload/New modal, Notifications bell popover, Theme toggle, and Sign In / Account modal (1-click Demo Sign In + email/name form) that updates the header to an interactive User Avatar + Account Dropdown + Sign Out.',
    '   - Video / Media / Store / Social / Dashboard cards & CTAs: clicking cards opens genuine interactive views/drawers/modals (e.g., playable <canvas> video player with Play/Pause/Seek/Like/Subscribe/Comments for video sites; Shopping Cart drawer with qty/promo/checkout for stores; Post Composer/Replies for social; Live CRUD/KPI filters for dashboards).',
    '   - Tabs, category/status filter pills, search inputs, sort dropdowns, billing switches, FAQ accordions, and counters: genuinely filter, sort, switch, or update visible items.',
    '   - Forms & inputs: validate required fields and display real inline confirmation/status feedback.',
    '5. Split files cleanly: always output "index.html", "css/styles.css", "js/main.js", optional linked "pages/<slug>.html", and compact local "./assets/images/*.svg" assets.',
  ].join('\n');

  const promptText = [
    'Convert this website screenshot into an accurate, faithful, ready-to-run working web application matching every visible section, color palette, typography scale, text label, card, table, input, and button.',
    'Use a unified SPA structure (`data-view` panels in index.html + complete `js/main.js`) so EVERY single button, icon button, sidebar/nav link, Sign In flow, media/item card, tab, search input, filter pill, dropdown, toggle, and form works interactively with localStorage persistence.',
    notes && notes.trim() ? `Additional user instructions: ${notes.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const imagePart = {
    inlineData: {
      mimeType,
      data: imageBuffer.toString('base64'),
    },
  };

  const callVisionGenerate = async (modelName: string, useHighThinking: boolean) =>
    ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [imagePart, { text: promptText }],
      },
      config: {
        systemInstruction,
        ...(useHighThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            siteTitle: {
              type: Type.STRING,
              description: 'Exact brand or page title shown in the screenshot.',
            },
            summary: {
              type: Type.STRING,
              description: 'Brief summary of the faithful layout and working interactive features.',
            },
            files: {
              type: Type.ARRAY,
              description: 'List of generated static website files.',
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description: 'Relative path inside project (e.g. index.html, css/styles.css, js/main.js, pages/<slug>.html, assets/images/hero.svg).',
                  },
                  content: {
                    type: Type.STRING,
                    description: 'Complete file source code.',
                  },
                },
                required: ['filePath', 'content'],
              },
            },
          },
          required: ['siteTitle', 'summary', 'files'],
        },
      },
    });

  let parsed: Partial<GeneratedSitePayload> | null = null;
  try {
    let response;
    try {
      response = await callVisionGenerate('gemini-4-hydrogen', true);
      parsed = safeParseModelJson<Partial<GeneratedSitePayload>>(response.text ?? '');
      if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
        throw new Error('EMPTY_OR_MALFORMED_PRIMARY');
      }
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : '';
      if (isRetryableAiError(primaryErr) || msg === 'EMPTY_OR_MALFORMED_PRIMARY') {
        await new Promise((r) => setTimeout(r, 350));
        response = await callVisionGenerate('gemini-3.1-flash-lite', false);
        parsed = safeParseModelJson<Partial<GeneratedSitePayload>>(response.text ?? '');
      } else {
        throw primaryErr;
      }
    }
  } catch (err) {
    if (err instanceof ScreenshotGenError) throw err;
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('API_KEY_INVALID')) {
      throw new ScreenshotGenError(
        403,
        'AI_UNCONFIGURED',
        'Gemini API key was rejected or missing. Please verify GEMINI_API_KEY in Settings > Secrets.',
      );
    }
    if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
      throw new ScreenshotGenError(
        429,
        'RATE_LIMITED',
        'AI quota or rate limit reached. Please wait a moment and try again.',
      );
    }
    if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
      throw new ScreenshotGenError(
        503,
        'AI_BUSY',
        'The website generator is temporarily busy due to high demand. Please retry in a few moments.',
      );
    }
    throw new ScreenshotGenError(
      502,
      'CAPTURE_FAILED',
      'Could not generate website code from the uploaded screenshot. Please try again.',
    );
  }

  if (!parsed) {
    throw new ScreenshotGenError(
      502,
      'CAPTURE_FAILED',
      'Website generator returned malformed output. Please try again.',
    );
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new ScreenshotGenError(
      502,
      'CAPTURE_FAILED',
      'No website files were generated from the screenshot.',
    );
  }

  const baseDir = path.resolve(job.siteDir);
  await fsp.mkdir(path.dirname(job.originalScreenshotPath), { recursive: true });
  await fsp.writeFile(job.originalScreenshotPath, imageBuffer);
  job.hasOriginalScreenshot = true;

  await fsp.mkdir(baseDir, { recursive: true });

  const normalizedEntries = normalizeAndRepairGeneratedFiles(
    parsed.files,
    parsed.siteTitle?.trim() || 'Generated Website',
  );

  let hasPackageJson = false;
  let hasReadme = false;
  let totalBytes = 0;

  for (const entry of normalizedEntries) {
    const destPath = path.resolve(baseDir, entry.cleanRel);
    if (!destPath.startsWith(baseDir + path.sep)) continue;

    let finalContent = entry.content;
    if (job.options.formatCode) {
      if (entry.ext === '.html' || entry.ext === '.htm') {
        finalContent = await formatCapturedCode(finalContent, 'html');
      } else if (entry.ext === '.css') {
        finalContent = await formatCapturedCode(finalContent, 'css');
      } else if (entry.ext === '.js' || entry.ext === '.mjs') {
        finalContent = await formatCapturedCode(finalContent, 'js');
      }
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, finalContent, 'utf8');
    totalBytes += Buffer.byteLength(finalContent, 'utf8');

    if (entry.cleanRel === 'package.json') hasPackageJson = true;
    if (entry.cleanRel.toLowerCase() === 'readme.md') hasReadme = true;

    if (entry.ext === '.html' || entry.ext === '.htm') stats.htmlCount += 1;
    else if (entry.ext === '.css') stats.cssCount += 1;
    else if (entry.ext === '.js' || entry.ext === '.mjs') stats.jsCount += 1;
    else if (entry.ext === '.svg') stats.imagesCount += 1;
    else stats.otherAssetsCount += 1;
  }

  // Derive siteTitle cleanly from index.html or Gemini payload
  if (parsed.siteTitle && parsed.siteTitle.trim()) {
    job.siteTitle = parsed.siteTitle.trim();
  } else {
    try {
      const idxRaw = await fsp.readFile(path.join(baseDir, 'index.html'), 'utf8');
      const $ = cheerio.load(idxRaw);
      const t = $('title').first().text().trim();
      if (t) job.siteTitle = t;
    } catch {
      // Keep hostname fallback
    }
  }

  stats.pagesCaptured = Math.max(1, stats.htmlCount);
  stats.assetsCaptured =
    stats.cssCount + stats.jsCount + stats.imagesCount + stats.fontsCount + stats.otherAssetsCount;
  stats.durationMs = Math.max(1, Date.now() - startTime);

  await writeArchiveWorkspaceConfig(job.siteDir);

  if (!hasPackageJson) {
    hasPackageJson = await writeArchivePackageJson({
      siteDir: job.siteDir,
      hostname: job.hostname,
      siteTitle: job.siteTitle,
    });
  }

  if (!hasReadme) {
    await writeArchiveReadme({
      siteDir: job.siteDir,
      targetUrl: `Generated from screenshot (${originalFilename})`,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: false,
      hasPackageJson,
      captureMode: 'screenshot',
    });
  }

  job.captureMode = 'screenshot';
  job.diagnostics = {
    brokenImages: [],
    failedResources: [],
    unresolvedLinks: [],
  };
  job.files = await listDirectoryFiles(job.siteDir);
  stats.totalBytes = Math.max(totalBytes, job.files.reduce((sum, f) => sum + f.size, 0));

  const rootFolderName = path.basename(job.zipFilename, '.zip') || `sitegrab-${job.hostname}`;
  const zipBytes = await createZipArchive(job.siteDir, job.zipPath, rootFolderName);
  if (!zipBytes || zipBytes <= 0) {
    throw new ScreenshotGenError(500, 'CAPTURE_FAILED', 'Generated project ZIP archive was empty.');
  }
  stats.zipBytes = zipBytes;
  stats.durationMs = Math.max(1, Date.now() - startTime);
}
