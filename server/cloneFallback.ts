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

const ALLOWED_CLONE_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.md']);

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

function normalizeCloneFilePath(rawPath: string): string | null {
  const cleaned = rawPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  if (!cleaned) return null;

  // Enforce clean top-level folder structure: index.html, pages/*, css/*, js/*, assets/images/*
  const ext = path.posix.extname(cleaned).toLowerCase();
  if (!ALLOWED_CLONE_EXTS.has(ext)) return null;

  const base = path.posix.basename(cleaned);
  if ((ext === '.html' || ext === '.htm') && cleaned !== 'index.html' && !cleaned.startsWith('pages/')) {
    return `pages/${base}`;
  }
  if (ext === '.css' && !cleaned.startsWith('css/')) {
    return `css/${base}`;
  }
  if ((ext === '.js' || ext === '.mjs') && !cleaned.startsWith('js/')) {
    return `js/${base}`;
  }
  if (ext === '.svg' && !cleaned.startsWith('assets/images/')) {
    return `assets/images/${base}`;
  }
  return cleaned;
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
    const headings = $('h1, h2, h3')
      .slice(0, 12)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean);
    const navLinks = $('header a, nav a')
      .slice(0, 12)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter(Boolean);

    return [
      title ? `Title: ${title}` : '',
      desc ? `Description: ${desc}` : '',
      themeColor ? `Theme Color: ${themeColor}` : '',
      navLinks.length > 0 ? `Navigation Links: ${navLinks.join(' | ')}` : '',
      headings.length > 0 ? `Headings: ${headings.join(' | ')}` : '',
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
  job: CaptureJob;
  stats: CaptureStats;
}): Promise<void> {
  const { targetUrl, failureReason, partialHtml, partialScreenshot, job, stats } = options;
  const startTime = Date.now();
  const ai = getGeminiClient();

  const parsedUrl = new URL(targetUrl);
  let htmlHints = partialHtml ? extractHtmlSummary(partialHtml) : '';

  // Optional fast public search grounding when no partial HTML was captured
  if (!htmlHints) {
    try {
      const lookupRes = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Briefly describe the public homepage structure, brand identity, primary colors, navigation items, hero headline, key sections, and footer links of the website ${targetUrl} (domain: ${parsedUrl.hostname}). Be concise and factual.`,
          config: {
            tools: [{ googleSearch: {} }],
          },
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
      ]);
      if (lookupRes && lookupRes.text) {
        htmlHints = lookupRes.text.slice(0, 3500);
      }
    } catch {
      // Proceed cleanly using URL/domain context
    }
  }

  const systemInstruction = [
    'You are an expert frontend architect creating a clean, responsive, VS Code-ready static website clone of a target public URL when direct headless capture was blocked or timed out.',
    'Project structure rules (STRICT):',
    '1. Organize files cleanly using this exact structure:',
    '   - "index.html" (main landing page)',
    '   - "css/styles.css" (all styling, responsive media queries, design tokens)',
    '   - "js/main.js" (interactive navigation, tabs, filters, modals, forms, or state)',
    '   - Optional "pages/<slug>.html" for secondary pages linked in the navbar',
    '   - Optional "assets/images/<name>.svg" for crisp vector illustrations, brand logos, and icons',
    '2. Every internal link and asset reference MUST use clean local relative paths ("./css/styles.css", "./js/main.js", "./assets/images/...").',
    '3. Do NOT include any external CDN URLs or external image links that could break offline.',
    '4. Build a rich, polished, faithful static clone matching the target brand/site domain, visual style, sections, interactive UI, and responsive desktop/tablet/mobile layouts.',
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
      htmlHints ? `Observed Public Site Context:\n${htmlHints}` : '',
      'Generate a complete, ready-to-run static website clone project using clean HTML5, CSS3, and vanilla JavaScript.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });

  const callGenerate = async (modelName: string) =>
    ai.models.generateContent({
      model: modelName,
      contents: { parts: promptParts },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            siteTitle: {
              type: Type.STRING,
              description: 'Title of the cloned website.',
            },
            summary: {
              type: Type.STRING,
              description: 'Brief description of the cloned project.',
            },
            files: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description: 'Relative path such as index.html, css/styles.css, js/main.js, or assets/images/hero.svg',
                  },
                  content: {
                    type: Type.STRING,
                    description: 'Complete file content.',
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
      response = await callGenerate('gemini-4-hydrogen');
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : '';
      if (msg.includes('503') || msg.includes('UNAVAILABLE')) {
        await new Promise((r) => setTimeout(r, 500));
        response = await callGenerate('gemini-3.1-flash-lite');
      } else {
        throw primaryErr;
      }
    }
  } catch (err) {
    throw new CloneFallbackError(
      'CAPTURE_FAILED',
      err instanceof Error ? err.message : 'Unable to generate fallback clone.',
    );
  }

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Fallback clone generator returned empty output.');
  }

  let parsed: {
    siteTitle?: string;
    summary?: string;
    files?: Array<{ filePath?: string; content?: string }>;
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Fallback clone generator returned malformed JSON.');
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'No files were produced by the fallback clone.');
  }

  // Reset siteDir cleanly before writing clone files
  await fsp.rm(job.siteDir, { recursive: true, force: true });
  const baseDir = path.resolve(job.siteDir);
  await fsp.mkdir(baseDir, { recursive: true });

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

  for (const item of parsed.files) {
    if (!item || typeof item.filePath !== 'string' || typeof item.content !== 'string') continue;
    const cleanRel = normalizeCloneFilePath(item.filePath);
    if (!cleanRel) continue;

    const ext = path.posix.extname(cleanRel).toLowerCase();
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
    const title = parsed.siteTitle?.trim() || parsedUrl.hostname;
    const fallbackHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="stylesheet" href="./css/styles.css" />
  </head>
  <body>
    <main style="font-family: system-ui, sans-serif; padding: 2rem;">
      <h1>${title}</h1>
      <p>${parsed.summary || `Static clone snapshot for ${targetUrl}.`}</p>
    </main>
    <script src="./js/main.js"></script>
  </body>
</html>`;
    await fsp.writeFile(path.join(baseDir, 'index.html'), fallbackHtml, 'utf8');
    stats.htmlCount += 1;
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
