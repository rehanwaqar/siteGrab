import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Response as PwResponse } from 'playwright';
import { formatCapturedCode } from './formatter.ts';
import {
  normalizeUrlKey,
  rewriteCssUrls,
  rewriteHtmlDocument,
  rewriteJsUrls,
} from './rewriter.ts';
import { fetchRobotsPolicy, isAllowedByRobots } from './robots.ts';
import { recoverSourceMaps } from './sourcemap.ts';
import { isBlockedIp, SsrfValidationError, validateExternalUrl } from './ssrf.ts';
import type {
  CaptureJob,
  CapturedAsset,
  CaptureStage,
  CaptureStats,
  ProgressEvent,
} from './types.ts';
import { createZipArchive, writeArchiveReadme } from './zipper.ts';

export const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_FILES = 500;
export const JOB_TIMEOUT_MS = 60 * 1000; // 60 seconds

export class CaptureError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

interface CapturedPage {
  originalUrl: string;
  normalizedUrl: string;
  localRelPath: string;
  html: string;
  title: string;
}

const SKIP_LINK_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp',
  '.css', '.js', '.mjs', '.cjs', '.json', '.xml', '.pdf', '.zip', '.tar', '.gz',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mp3', '.wav', '.ogg',
]);

function classifyAsset(
  urlStr: string,
  contentType: string,
  resourceType: string,
): CapturedAsset['category'] | null {
  const ct = contentType.toLowerCase().split(';')[0].trim();
  let pathname = '';
  try {
    pathname = new URL(urlStr).pathname.toLowerCase();
  } catch {
    pathname = urlStr.toLowerCase();
  }
  const ext = path.posix.extname(pathname);

  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    return null; // Pages are captured via rendered DOM
  }
  if (ct === 'text/css' || ext === '.css' || resourceType === 'stylesheet') {
    return 'css';
  }
  if (
    ct.includes('javascript') ||
    ct === 'application/ecmascript' ||
    ext === '.js' ||
    ext === '.mjs' ||
    ext === '.cjs' ||
    resourceType === 'script'
  ) {
    return 'js';
  }
  if (
    ct.startsWith('image/') ||
    ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp'].includes(ext) ||
    resourceType === 'image'
  ) {
    return 'images';
  }
  if (
    ct.startsWith('font/') ||
    ct.includes('font-') ||
    ct === 'application/font-woff' ||
    ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(ext) ||
    resourceType === 'font'
  ) {
    return 'fonts';
  }
  if (
    ct === 'application/json' ||
    ct === 'application/manifest+json' ||
    ct === 'text/xml' ||
    ct === 'application/xml' ||
    ['.json', '.webmanifest', '.xml'].includes(ext)
  ) {
    return 'data';
  }
  if (
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ['.mp4', '.webm', '.mp3', '.ogg', '.wav'].includes(ext) ||
    resourceType === 'media'
  ) {
    return 'media';
  }
  return null;
}

function defaultExtForCategory(category: CapturedAsset['category'], contentType: string): string {
  const ct = contentType.toLowerCase();
  switch (category) {
    case 'css':
      return '.css';
    case 'js':
      return '.js';
    case 'fonts':
      if (ct.includes('woff2')) return '.woff2';
      if (ct.includes('woff')) return '.woff';
      if (ct.includes('ttf')) return '.ttf';
      if (ct.includes('otf')) return '.otf';
      return '.woff2';
    case 'images':
      if (ct.includes('svg')) return '.svg';
      if (ct.includes('png')) return '.png';
      if (ct.includes('webp')) return '.webp';
      if (ct.includes('gif')) return '.gif';
      if (ct.includes('avif')) return '.avif';
      if (ct.includes('icon')) return '.ico';
      return '.jpg';
    case 'data':
      return '.json';
    case 'media':
      return ct.includes('audio') ? '.mp3' : '.mp4';
    default:
      return '';
  }
}

function buildAssetRelPath(
  urlStr: string,
  category: CapturedAsset['category'],
  contentType: string,
  usedPaths: Set<string>,
): string {
  let baseName = 'asset';
  let ext = '';
  try {
    const u = new URL(urlStr);
    const rawBase = path.posix.basename(u.pathname) || 'asset';
    ext = path.posix.extname(rawBase).toLowerCase();
    baseName = path.posix
      .basename(rawBase, ext)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 48) || 'asset';
  } catch {
    baseName = 'asset';
  }

  if (!ext || ext.length > 10) {
    ext = defaultExtForCategory(category, contentType);
  }

  const shortHash = crypto.createHash('sha1').update(urlStr).digest('hex').slice(0, 8);
  let candidate = `assets/${category}/${baseName}-${shortHash}${ext}`;
  let counter = 1;
  while (usedPaths.has(candidate)) {
    candidate = `assets/${category}/${baseName}-${shortHash}-${counter}${ext}`;
    counter++;
  }
  usedPaths.add(candidate);
  return candidate;
}

function buildPageRelPath(
  urlStr: string,
  entryNormalizedUrl: string,
  usedPaths: Set<string>,
): string {
  const norm = normalizeUrlKey(urlStr);
  if (norm === entryNormalizedUrl) {
    usedPaths.add('index.html');
    return 'index.html';
  }

  let rel = 'page.html';
  try {
    const u = new URL(urlStr);
    let cleanPath = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) {
      rel = 'index';
    } else {
      cleanPath = cleanPath
        .split('/')
        .filter((s) => s && s !== '.' && s !== '..')
        .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_'))
        .join('/');
      if (cleanPath.endsWith('.html') || cleanPath.endsWith('.htm')) {
        cleanPath = cleanPath.replace(/\.html?$/i, '');
      }
      rel = cleanPath || 'page';
    }

    if (u.search) {
      const qHash = crypto.createHash('sha1').update(u.search).digest('hex').slice(0, 6);
      rel = `${rel}-${qHash}`;
    }
  } catch {
    rel = 'page';
  }

  let candidate = `${rel}.html`;
  let counter = 1;
  while (usedPaths.has(candidate)) {
    candidate = `${rel}-${counter}.html`;
    counter++;
  }
  usedPaths.add(candidate);
  return candidate;
}

export async function runCaptureJob(
  job: CaptureJob,
  emit: (stage: CaptureStage, message: string, percent: number, detail?: string, errorCode?: string) => void,
  stats: CaptureStats,
): Promise<void> {
  const validatedHostCache = new Map<string, string[]>();
  const abortController = new AbortController();
  let timedOut = false;

  const jobTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, JOB_TIMEOUT_MS);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  let totalBytes = 0;
  let totalFiles = 0;
  const usedPaths = new Set<string>();
  const assets = new Map<string, CapturedAsset>(); // normalizedUrl -> CapturedAsset
  const pages: CapturedPage[] = [];

  const checkAborted = () => {
    if (timedOut) {
      throw new CaptureError('TIMEOUT', 'Capture timed out after 60 seconds.');
    }
    if (abortController.signal.aborted) {
      throw new CaptureError('ABORTED', 'Capture job was aborted.');
    }
  };

  const consumeBudget = (bytes: number, files: number): boolean => {
    if (totalFiles + files > MAX_FILES) {
      return false;
    }
    if (totalBytes + bytes > MAX_TOTAL_BYTES) {
      return false;
    }
    totalFiles += files;
    totalBytes += bytes;
    stats.totalBytes = totalBytes;
    return true;
  };

  try {
    // 1. Validate entry URL + DNS resolution (SSRF protection)
    emit('validating', 'Validating target URL and DNS records...', 6);
    const { url: entryUrl } = await validateExternalUrl(job.url, validatedHostCache);
    const entryOrigin = entryUrl.origin;
    const entryNormalized = normalizeUrlKey(entryUrl.toString());

    checkAborted();

    // 2. Respect robots.txt
    emit('validating', 'Checking robots.txt policy...', 12);
    const robotsPolicy = await fetchRobotsPolicy(entryOrigin, validatedHostCache);
    if (job.options.respectRobots && !isAllowedByRobots(robotsPolicy, entryUrl)) {
      throw new CaptureError(
        'ROBOTS_DISALLOWED',
        `Capture blocked by ${entryUrl.hostname}/robots.txt for "${entryUrl.pathname}".`,
      );
    }

    checkAborted();

    // 3. Launch Chromium in a fresh browser context
    emit('launching', 'Launching isolated Chromium browser context...', 18);
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 SiteGrab/1.0',
      ignoreHTTPSErrors: false,
    });

    // Enforce SSRF protection on every network request & redirect inside Chromium
    await context.route('**/*', async (route) => {
      const reqUrl = route.request().url();
      if (
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:') ||
        reqUrl.startsWith('about:')
      ) {
        await route.continue();
        return;
      }

      try {
        await validateExternalUrl(reqUrl, validatedHostCache);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();
    let fatalLimitError: CaptureError | null = null;
    const pendingAssetReads: Promise<void>[] = [];

    page.on('response', (response: PwResponse) => {
      const task = (async () => {
        try {
          if (fatalLimitError || abortController.signal.aborted) return;

          const status = response.status();
          if (status < 200 || status >= 300) return;

          const resUrl = response.url();
          if (!resUrl.startsWith('http://') && !resUrl.startsWith('https://')) return;

          // Verify actual remote peer IP (defends against DNS rebinding)
          const serverAddr = await response.serverAddr().catch(() => null);
          if (serverAddr?.ipAddress && isBlockedIp(serverAddr.ipAddress)) {
            fatalLimitError = new CaptureError(
              'BLOCKED_ADDRESS',
              'Target resolved to a private or internal network address during connection.',
            );
            abortController.abort();
            return;
          }

          await validateExternalUrl(resUrl, validatedHostCache).catch((err) => {
            if (err instanceof SsrfValidationError) {
              fatalLimitError = new CaptureError(err.code, err.message);
              abortController.abort();
            }
          });
          if (fatalLimitError) return;

          const normUrl = normalizeUrlKey(resUrl);
          if (assets.has(normUrl)) return;

          const headers = response.headers();
          const contentType = headers['content-type'] || '';
          const resourceType = response.request().resourceType();
          const category = classifyAsset(resUrl, contentType, resourceType);
          if (!category) return;

          const body = await response.body().catch(() => null);
          if (!body || body.length === 0) return;

          if (totalFiles + 1 > MAX_FILES) {
            fatalLimitError = new CaptureError(
              'FILE_LIMIT_EXCEEDED',
              `Site exceeds the ${MAX_FILES} file capture limit.`,
            );
            abortController.abort();
            return;
          }

          if (totalBytes + body.length > MAX_TOTAL_BYTES) {
            fatalLimitError = new CaptureError(
              'SIZE_LIMIT_EXCEEDED',
              'Site exceeds the 100 MB capture size limit.',
            );
            abortController.abort();
            return;
          }

          const localRelPath = buildAssetRelPath(resUrl, category, contentType, usedPaths);
          totalFiles += 1;
          totalBytes += body.length;

          assets.set(normUrl, {
            originalUrl: resUrl,
            normalizedUrl: normUrl,
            localRelPath,
            category,
            contentType,
            buffer: body,
          });

          stats.assetsCaptured = assets.size;
          stats.totalBytes = totalBytes;
        } catch {
          // Ignore individual non-fatal response read errors
        }
      })();
      pendingAssetReads.push(task);
    });

    // 4. BFS multi-page crawl (depth 0 = single page)
    const maxPages = Math.max(1, Math.min(25, job.options.maxPages || 1));
    const maxDepth = Math.max(0, Math.min(3, job.options.crawlDepth || 0));
    const visitedPages = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [{ url: entryUrl.toString(), depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
      checkAborted();
      if (fatalLimitError) throw fatalLimitError;

      const current = queue.shift()!;
      const normCurrent = normalizeUrlKey(current.url);
      if (visitedPages.has(normCurrent)) continue;
      visitedPages.add(normCurrent);

      const currentParsed = new URL(current.url);
      if (job.options.respectRobots && !isAllowedByRobots(robotsPolicy, currentParsed)) {
        stats.skippedRobots += 1;
        continue;
      }

      const progressPct = Math.min(58, 22 + Math.round((pages.length / maxPages) * 32));
      emit(
        'capturing',
        pages.length === 0
          ? `Capturing ${currentParsed.hostname}...`
          : `Capturing page ${pages.length + 1} of ${maxPages}: ${currentParsed.pathname}`,
        progressPct,
        current.url,
      );

      try {
        await page.goto(current.url, {
          waitUntil: 'networkidle',
          timeout: 22000,
        });
      } catch (err) {
        // If networkidle timed out on a page with polling/analytics, check if DOM loaded
        const readyState = await page.evaluate(() => document.readyState).catch(() => '');
        if (!readyState || (readyState !== 'interactive' && readyState !== 'complete')) {
          if (pages.length === 0) {
            throw new CaptureError(
              'NAVIGATION_ERROR',
              `Could not load "${current.url}": ${err instanceof Error ? err.message : 'Navigation failed'}`,
            );
          }
          continue;
        }
      }

      checkAborted();
      if (fatalLimitError) throw fatalLimitError;

      // Verify final URL after any client/server redirects
      const finalPageUrl = page.url();
      await validateExternalUrl(finalPageUrl, validatedHostCache);

      // Scroll page incrementally to trigger lazy-loaded images & chunks
      await page.evaluate(async () => {
        const scrollStep = Math.max(350, Math.floor(window.innerHeight * 0.8));
        const maxScroll = Math.min(document.body.scrollHeight || 0, 18000);
        for (let y = 0; y <= maxScroll; y += scrollStep) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 140));
        }
        window.scrollTo(0, 0);
      });

      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
      await Promise.allSettled(pendingAssetReads.splice(0));

      checkAborted();
      if (fatalLimitError) throw fatalLimitError;

      const html = await page.content();
      const title = (await page.title().catch(() => '')) || currentParsed.hostname;

      const htmlBytes = Buffer.byteLength(html, 'utf8');
      if (!consumeBudget(htmlBytes, 1)) {
        if (totalFiles + 1 > MAX_FILES) {
          throw new CaptureError('FILE_LIMIT_EXCEEDED', `Site exceeds ${MAX_FILES} files limit.`);
        }
        throw new CaptureError('SIZE_LIMIT_EXCEEDED', 'Site exceeds 100 MB capture limit.');
      }

      const localRelPath = buildPageRelPath(current.url, entryNormalized, usedPaths);
      pages.push({
        originalUrl: finalPageUrl,
        normalizedUrl: normCurrent,
        localRelPath,
        html,
        title,
      });

      if (pages.length === 1) {
        job.siteTitle = title;
      }
      stats.pagesCaptured = pages.length;

      // Enqueue internal links if within depth limit
      if (current.depth < maxDepth && pages.length < maxPages) {
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map((a) =>
            (a as HTMLAnchorElement).getAttribute('href') || '',
          ),
        );

        for (const rawHref of hrefs) {
          if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:') || rawHref.startsWith('javascript:')) {
            continue;
          }
          try {
            const candidate = new URL(rawHref, finalPageUrl);
            if (candidate.origin !== entryOrigin) continue;
            if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') continue;
            const ext = path.posix.extname(candidate.pathname).toLowerCase();
            if (ext && SKIP_LINK_EXTS.has(ext)) continue;

            candidate.hash = '';
            const normCand = candidate.toString();
            if (!visitedPages.has(normCand)) {
              queue.push({ url: normCand, depth: current.depth + 1 });
            }
          } catch {
            // Ignore invalid links
          }
        }
      }
    }

    if (pages.length === 0) {
      throw new CaptureError('NAVIGATION_ERROR', 'No pages could be captured from this URL.');
    }

    // Close browser right after capture completes so Chromium memory is freed immediately
    await context.close().catch(() => {});
    context = null;
    await browser.close().catch(() => {});
    browser = null;

    checkAborted();

    // 5. Build URL maps for rewriting
    const assetPathMap = new Map<string, string>();
    for (const asset of assets.values()) {
      assetPathMap.set(asset.normalizedUrl, asset.localRelPath);
    }

    const pagePathMap = new Map<string, string>();
    for (const pg of pages) {
      pagePathMap.set(pg.normalizedUrl, pg.localRelPath);
      pagePathMap.set(normalizeUrlKey(pg.originalUrl), pg.localRelPath);
    }

    // 6. Optional Source Map Recovery
    if (job.options.recoverSourceMaps) {
      emit('recovering', 'Scanning CSS & JS bundles for published source maps...', 64);
      stats.sourceMapsRecovered = await recoverSourceMaps({
        assets: Array.from(assets.values()),
        siteDir: job.siteDir,
        remainingBytes: () => Math.max(0, MAX_TOTAL_BYTES - totalBytes),
        remainingFiles: () => Math.max(0, MAX_FILES - totalFiles),
        consumeBudget,
        validatedHostCache,
        signal: abortController.signal,
      });
    }

    checkAborted();

    // 7. Rewrite URLs in CSS, JS, HTML and optionally format with Prettier
    emit('rewriting', 'Rewriting asset paths to relative local references...', 74);

    await fs.mkdir(job.siteDir, { recursive: true });

    // Write & rewrite assets
    const assetList = Array.from(assets.values());
    for (let i = 0; i < assetList.length; i++) {
      checkAborted();
      const asset = assetList[i];
      const destPath = path.resolve(job.siteDir, asset.localRelPath);
      if (!destPath.startsWith(job.siteDir + path.sep)) continue;

      await fs.mkdir(path.dirname(destPath), { recursive: true });

      if (asset.category === 'css') {
        let cssText = asset.buffer.toString('utf8');
        cssText = rewriteCssUrls(cssText, asset.originalUrl, asset.localRelPath, assetPathMap);
        if (job.options.formatCode) {
          cssText = await formatCapturedCode(cssText, 'css');
        }
        await fs.writeFile(destPath, cssText, 'utf8');
      } else if (asset.category === 'js') {
        let jsText = asset.buffer.toString('utf8');
        jsText = rewriteJsUrls(jsText, asset.localRelPath, assetPathMap, entryOrigin);
        if (job.options.formatCode) {
          jsText = await formatCapturedCode(jsText, 'js');
        }
        await fs.writeFile(destPath, jsText, 'utf8');
      } else {
        await fs.writeFile(destPath, asset.buffer);
      }
    }

    if (job.options.formatCode) {
      emit('formatting', 'Formatting HTML, CSS, and JavaScript with Prettier...', 84);
    }

    // Write & rewrite HTML pages
    for (const pg of pages) {
      checkAborted();
      const destPath = path.resolve(job.siteDir, pg.localRelPath);
      if (!destPath.startsWith(job.siteDir + path.sep)) continue;

      await fs.mkdir(path.dirname(destPath), { recursive: true });

      let rewrittenHtml = rewriteHtmlDocument({
        html: pg.html,
        pageOriginalUrl: pg.originalUrl,
        pageLocalRelPath: pg.localRelPath,
        assetPathMap,
        pagePathMap,
      });

      if (job.options.formatCode) {
        rewrittenHtml = await formatCapturedCode(rewrittenHtml, 'html');
      }

      await fs.writeFile(destPath, rewrittenHtml, 'utf8');
    }

    // 8. Generate README.md inside captured folder
    await writeArchiveReadme({
      siteDir: job.siteDir,
      targetUrl: job.url,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: job.options.recoverSourceMaps,
    });

    checkAborted();

    // 9. Zip folder
    emit('zipping', 'Compressing site archive into ZIP package...', 93);
    const zipBytes = await createZipArchive(job.siteDir, job.zipPath);
    stats.zipBytes = zipBytes;

    emit('ready', 'Snapshot complete and ready for preview or download.', 100);
  } catch (err) {
    if (err instanceof CaptureError) {
      throw err;
    }
    if (err instanceof SsrfValidationError) {
      throw new CaptureError(err.code, err.message);
    }
    if (timedOut) {
      throw new CaptureError('TIMEOUT', 'Capture timed out after 60 seconds.');
    }
    throw new CaptureError(
      'CAPTURE_FAILED',
      err instanceof Error ? err.message : 'An unexpected error occurred during capture.',
    );
  } finally {
    clearTimeout(jobTimer);
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function buildJobResultSummary(job: CaptureJob): Promise<ProgressEvent> {
  return job.lastEvent;
}
