import fsp from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import { formatCapturedCode } from './formatter.ts';
import type { CaptureJob, CaptureStats } from './types.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

export const MAX_UPLOAD_SCREENSHOT_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.md']);

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
    'You are an expert frontend engineer converting a website/UI screenshot into a complete, pixel-faithful, responsive static website project.',
    'Requirements:',
    '1. Generate clean, semantic HTML5, modern CSS3, and vanilla JavaScript.',
    '2. Recreate the exact visual hierarchy, color palette, typography scale, spacing, header/navigation, hero, cards/grids, tables/forms, buttons, badges, and footer visible in the screenshot.',
    '3. Split files cleanly: always provide "index.html", "css/styles.css", and add "js/main.js" for any interactive tabs, menus, modals, or UI controls.',
    '4. Reference local assets strictly with relative paths ("./css/styles.css", "./js/main.js", "./assets/images/...").',
    '5. Do NOT use external image URLs or CDN links that might break offline. Instead, use crisp inline SVGs, CSS gradients, or local "./assets/images/*.svg" files for icons, illustrations, avatars, and product thumbnails.',
    '6. Keep all text readable and responsive across desktop, tablet, and mobile viewports.',
  ].join('\n');

  const promptText = [
    'Convert this website screenshot into a complete, ready-to-run static website project matching the layout and visual style as closely as possible.',
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

  const callVisionGenerate = async (modelName: string) =>
    ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [imagePart, { text: promptText }],
      },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            siteTitle: {
              type: Type.STRING,
              description: 'Short descriptive title for the generated website.',
            },
            summary: {
              type: Type.STRING,
              description: 'Brief summary of the generated layout and files.',
            },
            files: {
              type: Type.ARRAY,
              description: 'List of generated static website files.',
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description: 'Relative path inside project (e.g. index.html, css/styles.css, js/main.js, assets/images/hero.svg).',
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

  let response;
  try {
    try {
      response = await callVisionGenerate('gemini-4-hydrogen');
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : '';
      if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
        await new Promise((r) => setTimeout(r, 500));
        response = await callVisionGenerate('gemini-3.1-flash-lite');
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

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new ScreenshotGenError(
      502,
      'CAPTURE_FAILED',
      'Website generator returned an empty response. Please try again.',
    );
  }

  let parsed: Partial<GeneratedSitePayload>;
  try {
    parsed = JSON.parse(rawText) as Partial<GeneratedSitePayload>;
  } catch {
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

  let hasIndexHtml = false;
  let hasPackageJson = false;
  let hasReadme = false;
  let totalBytes = 0;

  for (const item of parsed.files) {
    if (!item || typeof item.filePath !== 'string' || typeof item.content !== 'string') continue;
    const cleanRel = item.filePath
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('/');
    if (!cleanRel) continue;

    const ext = path.posix.extname(cleanRel).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) continue;

    const destPath = path.resolve(baseDir, cleanRel);
    if (!destPath.startsWith(baseDir + path.sep)) continue;

    let finalContent = item.content;
    if (job.options.formatCode) {
      if (ext === '.html' || ext === '.htm') {
        finalContent = await formatCapturedCode(finalContent, 'html');
      } else if (ext === '.css') {
        finalContent = await formatCapturedCode(finalContent, 'css');
      } else if (ext === '.js' || ext === '.mjs') {
        finalContent = await formatCapturedCode(finalContent, 'js');
      }
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, finalContent, 'utf8');
    totalBytes += Buffer.byteLength(finalContent, 'utf8');

    if (cleanRel === 'index.html') hasIndexHtml = true;
    if (cleanRel === 'package.json') hasPackageJson = true;
    if (cleanRel.toLowerCase() === 'readme.md') hasReadme = true;

    if (ext === '.html' || ext === '.htm') stats.htmlCount += 1;
    else if (ext === '.css') stats.cssCount += 1;
    else if (ext === '.js' || ext === '.mjs') stats.jsCount += 1;
    else if (ext === '.svg') stats.imagesCount += 1;
    else stats.otherAssetsCount += 1;
  }

  if (!hasIndexHtml) {
    // Guarantee an entry index.html exists
    const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${parsed.siteTitle || 'Generated Website'}</title>
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; padding: 2rem;">
      <h1>${parsed.siteTitle || 'Generated Website'}</h1>
      <p>${parsed.summary || 'Website generated from screenshot.'}</p>
    </main>
  </body>
</html>`;
    await fsp.writeFile(path.join(baseDir, 'index.html'), fallbackHtml, 'utf8');
    stats.htmlCount += 1;
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
