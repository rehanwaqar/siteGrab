import fsp from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import { formatCapturedCode } from './formatter.ts';
import { normalizeAndRepairGeneratedFiles } from './generatedSiteRepair.ts';
import { safeFetchWithRedirectValidation } from './ssrf.ts';
import type { CaptureJob, CaptureStats } from './types.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

export class CloneFallbackError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloneFallbackError';
    this.code = code;
  }
}

let sharedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new CloneFallbackError(
      'AI_UNCONFIGURED',
      'Fallback website cloning requires GEMINI_API_KEY on the server.',
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

function extractHtmlSummary(rawHtml: string): string {
  try {
    const $ = cheerio.load(rawHtml);
    const title = $('title').first().text().trim();
    const desc =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';
    const themeColor = $('meta[name="theme-color"]').attr('content')?.trim() || '';
    const navLinks = $('header a, nav a')
      .slice(0, 14)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean);
    const headings = $('h1, h2, h3')
      .slice(0, 14)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean);
    const paragraphs = $('main p, section p, article p')
      .slice(0, 8)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter((t) => t.length > 20)
      .map((t) => t.slice(0, 200));

    return [
      title ? `Title: ${title}` : '',
      desc ? `Description: ${desc}` : '',
      themeColor ? `Theme Color: ${themeColor}` : '',
      navLinks.length > 0 ? `Navigation Links: ${navLinks.join(' | ')}` : '',
      headings.length > 0 ? `Headings: ${headings.join(' | ')}` : '',
      paragraphs.length > 0 ? `Observed Body Copy:\n- ${paragraphs.join('\n- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

export async function generateCloneFallbackForUrl(options: {
  targetUrl: string;
  failureReason: string;
  partialHtml?: string;
  partialScreenshot?: Buffer | null;
  validatedHostCache?: Map<string, string[]>;
  job: CaptureJob;
  stats: CaptureStats;
}): Promise<void> {
  const {
    targetUrl,
    failureReason,
    partialHtml,
    partialScreenshot,
    validatedHostCache,
    job,
    stats,
  } = options;
  const startTime = Date.now();
  const ai = getGeminiClient();

  const parsedUrl = new URL(targetUrl);
  let htmlHints = partialHtml ? extractHtmlSummary(partialHtml) : '';

  // 1. If we don't have partial HTML yet, try a fast SSRF-validated HTTP GET to extract real page structure & copy
  if (!htmlHints) {
    try {
      const hostCache = validatedHostCache ?? new Map<string, string[]>();
      const { response } = await Promise.race([
        safeFetchWithRedirectValidation(
          targetUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          },
          4,
          hostCache,
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6500)),
      ]);
      const ct = (response.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) {
        const fetchedHtml = await response.text();
        const extracted = extractHtmlSummary(fetchedHtml);
        if (extracted) {
          htmlHints = extracted;
        }
      }
    } catch {
      // Fall through to Google Search grounding
    }
  }

  // 2. Enrich via public Google Search grounding for visual palette, sections, features & domain info
  if (!htmlHints || htmlHints.length < 300) {
    try {
      const lookupRes = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: [
            `Inspect the public website ${targetUrl} (domain: ${parsedUrl.hostname}).`,
            'Summarize in structured detail:',
            '- Brand identity, core product/service, and primary headline/tagline',
            '- Color palette (background, accent, surface colors) and typography style',
            '- Top navigation links and secondary pages',
            '- Main homepage sections, interactive features (calculators, filters, tabs, search, forms, pricing), and footer structure',
            'Be factual and concise.',
          ].join('\n'),
          config: {
            tools: [{ googleSearch: {} }],
          },
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      if (lookupRes && lookupRes.text) {
        const searchText = lookupRes.text.slice(0, 3500);
        htmlHints = htmlHints ? `${htmlHints}\n\nPublic Site Context:\n${searchText}` : searchText;
      }
    } catch {
      // Proceed cleanly using URL/domain context
    }
  }

  const systemInstruction = [
    'You are a senior frontend engineer creating a COMPLETE, REAL, WORKING, INTERACTIVE static website project modeling the requested public URL.',
    'STRICT QUALITY RULES — NEVER VIOLATE THESE:',
    '1. NEVER produce dummy, placeholder, skeleton, "coming soon", "under construction", "Static clone snapshot", or "Lorem ipsum" copy. Write rich, domain-accurate, realistic headings, copy, pricing/metrics, cards, and UI labels.',
    '2. Build a genuinely WORKING website with real interactive functionality in "js/main.js": responsive mobile menu toggle, interactive tabs/filters/search/sorting, interactive cards or detail modals, working client-side calculator/forms with validation & live DOM feedback, smooth scrolling, and state updates.',
    '3. Project structure (STRICT):',
    '   - "index.html": complete main landing page linking "./css/styles.css" and "./js/main.js"',
    '   - "css/styles.css": full modern CSS3 styling matching the brand theme (dark or light), CSS variables, flexbox/grid layouts, hover/focus states, and responsive breakpoints for desktop, tablet, and mobile',
    '   - "js/main.js": clean vanilla JS powering every interactive element on index.html and subpages',
    '   - "pages/<slug>.html": create 2-3 working linked subpages matching the main navbar links (each linking "../css/styles.css" and "../js/main.js" cleanly)',
    '   - "assets/images/<name>.svg": custom SVG illustrations, icons, and brand logo referenced via "./assets/images/<name>.svg"',
    '4. Zero external CDN URLs or external image links that could break offline.',
    '5. Every navigation link, CTA button, form, tab, and filter MUST actually do something visible when clicked.',
  ].join('\n');

  const promptParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (partialScreenshot && partialScreenshot.length > 0) {
    promptParts.push({
      inlineData: {
        mimeType: 'image/png',
        data: partialScreenshot.toString('base64'),
      },
    });
  }

  promptParts.push({
    text: [
      `Target Website URL: ${targetUrl}`,
      `Hostname: ${parsedUrl.hostname}`,
      htmlHints
        ? `Observed Real Website Context:\n${htmlHints}`
        : `Infer the full domain purpose, brand styling, sections, and interactive workflows for ${parsedUrl.hostname}.`,
      'Build a full, working, multi-section interactive website (HTML5 + CSS3 + vanilla JS + SVG assets + linked subpages) ready for live preview and VS Code export.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });

  const callGenerate = async (modelName: string, useMediumThinking: boolean) =>
    ai.models.generateContent({
      model: modelName,
      contents: { parts: promptParts },
      config: {
        systemInstruction,
        ...(useMediumThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            siteTitle: {
              type: Type.STRING,
              description: 'Title of the website.',
            },
            summary: {
              type: Type.STRING,
              description: 'Brief summary of the generated working website.',
            },
            files: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description:
                      'Relative path: index.html, css/styles.css, js/main.js, pages/<name>.html, or assets/images/<name>.svg',
                  },
                  content: {
                    type: Type.STRING,
                    description: 'Complete working source code for this file.',
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
      response = await callGenerate('gemini-4-hydrogen', true);
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : '';
      if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
        await new Promise((r) => setTimeout(r, 500));
        response = await callGenerate('gemini-3.1-flash-lite', false);
      } else {
        throw primaryErr;
      }
    }
  } catch (err) {
    throw new CloneFallbackError(
      'CAPTURE_FAILED',
      err instanceof Error ? err.message : 'Unable to generate fallback website.',
    );
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Website generator returned empty output.');
  }

  let parsed: {
    siteTitle?: string;
    summary?: string;
    files?: Array<{ filePath?: string; content?: string }>;
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Website generator returned malformed JSON.');
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'No files were produced by the website generator.');
  }

  const normalizedEntries = normalizeAndRepairGeneratedFiles(
    parsed.files,
    parsed.siteTitle?.trim() || parsedUrl.hostname,
  );

  // Reset siteDir cleanly before writing files
  await fsp.rm(job.siteDir, { recursive: true, force: true });
  const baseDir = path.resolve(job.siteDir);
  await fsp.mkdir(baseDir, { recursive: true });

  if (partialScreenshot && partialScreenshot.length > 0) {
    await fsp.mkdir(path.dirname(job.originalScreenshotPath), { recursive: true });
    await fsp.writeFile(job.originalScreenshotPath, partialScreenshot);
    job.hasOriginalScreenshot = true;
  }

  stats.pagesCaptured = 0;
  stats.assetsCaptured = 0;
  stats.htmlCount = 0;
  stats.cssCount = 0;
  stats.jsCount = 0;
  stats.imagesCount = 0;
  stats.fontsCount = 0;
  stats.otherAssetsCount = 0;
  stats.totalBytes = 0;

  let hasIndexHtml = false;
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

    if (entry.cleanRel === 'index.html') hasIndexHtml = true;
    if (entry.cleanRel === 'package.json') hasPackageJson = true;
    if (entry.cleanRel.toLowerCase() === 'readme.md') hasReadme = true;

    if (entry.ext === '.html' || entry.ext === '.htm') stats.htmlCount += 1;
    else if (entry.ext === '.css') stats.cssCount += 1;
    else if (entry.ext === '.js' || entry.ext === '.mjs') stats.jsCount += 1;
    else if (entry.ext === '.svg') stats.imagesCount += 1;
    else stats.otherAssetsCount += 1;
  }

  if (!hasIndexHtml) {
    throw new CloneFallbackError(
      'CAPTURE_FAILED',
      'Website generator did not produce an index.html entry page.',
    );
  }

  job.siteTitle = parsed.siteTitle?.trim() || parsedUrl.hostname;
  job.captureMode = 'clone';
  job.fallbackReason = failureReason;

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
      targetUrl,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: false,
      hasPackageJson,
      captureMode: 'clone',
      fallbackReason: failureReason,
    });
  }

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
    throw new CloneFallbackError('CAPTURE_FAILED', 'Generated clone ZIP archive was empty.');
  }
  stats.zipBytes = zipBytes;
  stats.durationMs = Math.max(1, Date.now() - startTime);
}
