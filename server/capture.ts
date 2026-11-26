import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Request as PwRequest,
  type Response as PwResponse,
} from 'playwright';
import * as cheerio from 'cheerio';
import { formatCapturedCode } from './formatter.ts';
import {
  normalizeUrlKey,
  rewriteCssUrls,
  rewriteHtmlDocument,
  rewriteJsUrls,
} from './rewriter.ts';
import { fetchRobotsPolicy, isAllowedByRobots } from './robots.ts';
import { recoverSourceMaps } from './sourcemap.ts';
import {
  isBlockedIp,
  safeFetchWithRedirectValidation,
  SsrfValidationError,
  validateExternalUrl,
} from './ssrf.ts';
import type {
  CaptureJob,
  CapturedAsset,
  CaptureStage,
  CaptureStats,
  FailedResourceEntry,
  ProgressEvent,
} from './types.ts';
import { generateCloneFallbackForUrl } from './cloneFallback.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

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

const PRIVATE_PREVIEW_HOST_RE =
  /(webcontainer\.io|stackblitz\.io|bolt\.new|lovable\.dev|lovableproject\.com|codesandbox\.io|replit\.dev|gitpod\.io|ngrok-free\.app|ngrok\.io)$/i;

const LOGIN_REDIRECT_RE = /\/(login|signin|sign-in|auth|oauth|sso)(\/|$|\?)/i;

function isPrivateOrAuthHost(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (PRIVATE_PREVIEW_HOST_RE.test(u.hostname)) return true;
    if (
      u.hostname.includes('accounts.google.com') ||
      u.hostname.includes('auth0.com') ||
      u.hostname.includes('login.microsoftonline.com')
    ) {
      return true;
    }
    return LOGIN_REDIRECT_RE.test(u.pathname);
  } catch {
    return false;
  }
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
    baseName =
      path.posix
        .basename(rawBase, ext)
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 36) || 'asset';
  } catch {
    baseName = 'asset';
  }

  if (!ext || ext.length > 10) {
    ext = defaultExtForCategory(category, contentType);
  }

  const folder =
    category === 'css'
      ? 'css'
      : category === 'js'
        ? 'js'
        : `assets/${category}`;

  const shortHash = crypto.createHash('sha1').update(urlStr).digest('hex').slice(0, 6);
  let candidate = `${folder}/${baseName}-${shortHash}${ext}`;
  let counter = 1;
  while (usedPaths.has(candidate)) {
    candidate = `${folder}/${baseName}-${shortHash}-${counter}${ext}`;
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

  let rel = 'page';
  try {
    const u = new URL(urlStr);
    let cleanPath = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!cleanPath) {
      rel = 'home';
    } else {
      cleanPath = cleanPath
        .split('/')
        .filter((s) => s && s !== '.' && s !== '..')
        .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_'))
        .join('-');
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

  let candidate = `pages/${rel}.html`;
  let counter = 1;
  while (usedPaths.has(candidate)) {
    candidate = `pages/${rel}-${counter}.html`;
    counter++;
  }
  usedPaths.add(candidate);
  return candidate;
}

export async function runCaptureJob(
  job: CaptureJob,
  emit: (
    stage: CaptureStage,
    message: string,
    percent: number,
    detail?: string,
    errorCode?: string,
  ) => void,
  stats: CaptureStats,
): Promise<void> {
  const startTime = Date.now();
  const validatedHostCache = new Map<string, string[]>();
  const abortController = new AbortController();
  let timedOut = false;

  const effectiveTimeoutMs = Math.max(15_000, Math.min(120_000, job.options.timeoutMs ?? JOB_TIMEOUT_MS));
  const waitStrategy =
    job.options.waitStrategy === 'networkidle' || job.options.waitStrategy === 'domcontentloaded'
      ? job.options.waitStrategy
      : 'load';

  const jobTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, effectiveTimeoutMs);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  let totalBytes = 0;
  let totalFiles = 0;
  const usedPaths = new Set<string>();
  const assets = new Map<string, CapturedAsset>(); // normalizedUrl -> CapturedAsset
  const pages: CapturedPage[] = [];
  const failedResources: FailedResourceEntry[] = [];
  const failedSeen = new Set<string>();
  const brokenImages: Array<{ src: string; page: string; reason: string }> = [];
  const unresolvedLinks: Array<{ href: string; page: string; type: 'asset' | 'navigation' }> = [];
  const intentionallyBlockedUrls = new Set<string>();
  let partialHtml = '';
  let partialScreenshot: Buffer | null = null;

  const recordFailedResource = (entry: FailedResourceEntry) => {
    if (failedSeen.has(entry.url) || failedResources.length >= 100) return;
    failedSeen.add(entry.url);
    failedResources.push(entry);
    stats.failedAssetsCount = failedResources.length;
  };

  const checkAborted = () => {
    if (timedOut) {
      const secs = Math.round(effectiveTimeoutMs / 1000);
      throw new CaptureError('TIMEOUT', `Capture timed out after ${secs} seconds.`);
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
    try {
      browser = await chromium.launch({
        headless: true,
        channel: 'chromium',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
        ],
      });
    } catch (launchErr) {
      const msg = launchErr instanceof Error ? launchErr.message : String(launchErr);
      if (
        msg.includes("Executable doesn't exist") ||
        msg.includes('chromium') ||
        msg.includes('playwright install')
      ) {
        throw new CaptureError(
          'MISSING_CHROMIUM',
          'Chromium browser binary is not installed in this environment. Run "npx playwright install chromium" on the server.',
        );
      }
      throw new CaptureError('CAPTURE_FAILED', `Failed to launch browser: ${msg}`);
    }

    const majorVersion = browser.version().split('.')[0] || '136';
    const isMobile = job.options.mobileViewport;
    context = await browser.newContext({
      viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile,
      hasTouch: isMobile,
      locale: 'en-US',
      userAgent: isMobile
        ? `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Mobile Safari/537.36`
        : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-ch-ua': `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`,
        'sec-ch-ua-mobile': isMobile ? '?1' : '?0',
        'sec-ch-ua-platform': isMobile ? '"Android"' : '"Linux"',
      },
      ignoreHTTPSErrors: false,
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // Enforce SSRF protection + optional image/font exclusions on every network request
    await context.route('**/*', async (route) => {
      const req = route.request();
      const reqUrl = req.url();
      const rType = req.resourceType();

      if (
        reqUrl.startsWith('data:') ||
        reqUrl.startsWith('blob:') ||
        reqUrl.startsWith('about:')
      ) {
        await route.continue();
        return;
      }

      if (!job.options.includeImages && rType === 'image') {
        intentionallyBlockedUrls.add(reqUrl);
        await route.abort('blockedbyclient');
        return;
      }

      if (!job.options.includeFonts && rType === 'font') {
        intentionallyBlockedUrls.add(reqUrl);
        await route.abort('blockedbyclient');
        return;
      }

      try {
        await validateExternalUrl(reqUrl, validatedHostCache);
        await route.continue();
      } catch (err) {
        recordFailedResource({
          url: reqUrl,
          resourceType: rType,
          reason: err instanceof Error ? err.message : 'Blocked internal/private address',
        });
        await route.abort('blockedbyclient');
      }
    });

    const page = await context.newPage();
    let fatalLimitError: CaptureError | null = null;
    const pendingAssetReads: Promise<void>[] = [];

    page.on('requestfailed', (req: PwRequest) => {
      if (abortController.signal.aborted) return;
      const reqUrl = req.url();
      if (intentionallyBlockedUrls.has(reqUrl)) return;
      if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) return;
      recordFailedResource({
        url: reqUrl,
        resourceType: req.resourceType(),
        reason: req.failure()?.errorText || 'Network request failed',
      });
    });

    page.on('response', (response: PwResponse) => {
      const task = (async () => {
        try {
          if (fatalLimitError || abortController.signal.aborted) return;

          const status = response.status();
          const resUrl = response.url();
          const resourceType = response.request().resourceType();

          if (status >= 400) {
            if (resUrl.startsWith('http://') || resUrl.startsWith('https://')) {
              recordFailedResource({
                url: resUrl,
                resourceType,
                status,
                reason: `HTTP ${status} ${response.statusText() || ''}`.trim(),
              });
            }
            return;
          }

          if (status < 200 || status >= 300) return;
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
          const category = classifyAsset(resUrl, contentType, resourceType);
          if (!category) return;

          if (!job.options.includeImages && category === 'images') return;
          if (!job.options.includeFonts && category === 'fonts') return;

          const body = await Promise.race([
            response.body().catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 4500)),
          ]);
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

          if (category === 'css') stats.cssCount += 1;
          else if (category === 'js') stats.jsCount += 1;
          else if (category === 'images') stats.imagesCount += 1;
          else if (category === 'fonts') stats.fontsCount += 1;
          else stats.otherAssetsCount += 1;

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

    await fs.mkdir(job.siteDir, { recursive: true });

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
          ? `Loading ${currentParsed.hostname} and downloading assets...`
          : `Crawling page ${pages.length + 1} of ${maxPages}: ${currentParsed.pathname}`,
        progressPct,
        current.url,
      );

      const pageGotoTimeout = effectiveTimeoutMs > 60_000 ? 45_000 : 28_000;
      let mainResponse: PwResponse | null = null;
      try {
        mainResponse = await page.goto(current.url, {
          waitUntil: waitStrategy,
          timeout: pageGotoTimeout,
        });
      } catch (err) {
        // Automatic fast fallback to domcontentloaded if 'load' or 'networkidle' timed out
        if (waitStrategy !== 'domcontentloaded' && String(err).toLowerCase().includes('timeout')) {
          try {
            mainResponse = await page.goto(current.url, {
              waitUntil: 'domcontentloaded',
              timeout: 16_000,
            });
          } catch {
            // Fall through to readyState check
          }
        }
        const readyState = await page.evaluate(() => document.readyState).catch(() => '');
        if (!readyState || (readyState !== 'interactive' && readyState !== 'complete')) {
          if (pages.length === 0 && !mainResponse) {
            const rawMsg = err instanceof Error ? err.message : 'Navigation failed';
            if (rawMsg.toLowerCase().includes('timeout')) {
              throw new CaptureError(
                'TIMEOUT',
                `Page navigation timed out using the "${waitStrategy}" strategy (${Math.round(pageGotoTimeout / 1000)}s limit).`,
              );
            }
            if (rawMsg.includes('ERR_NAME_NOT_RESOLVED')) {
              throw new CaptureError(
                'DNS_ERROR',
                `Domain "${currentParsed.hostname}" could not be resolved. Check the URL spelling or DNS availability.`,
              );
            }
            if (isPrivateOrAuthHost(current.url) && (rawMsg.includes('ERR_CONNECTION') || rawMsg.includes('ERR_ABORTED'))) {
              throw new CaptureError(
                'PRIVATE_SITE',
                `This looks like a private workspace preview URL (${currentParsed.hostname}) that cannot be fetched externally.`,
              );
            }
            if (rawMsg.includes('net::ERR_')) {
              throw new CaptureError(
                'NETWORK_ERROR',
                `Network error loading "${current.url}": ${rawMsg.split('\n')[0]}`,
              );
            }
            throw new CaptureError(
              'NAVIGATION_ERROR',
              `Could not load "${current.url}": ${rawMsg.split('\n')[0]}`,
            );
          }
          if (!mainResponse) continue;
        }
      }

      const landedUrl = page.url();
      let httpFallbackUsed = false;
      if (pages.length === 0 && mainResponse && mainResponse.status() >= 400) {
        const status = mainResponse.status();
        if (status === 401 || status === 403) {
          if (isPrivateOrAuthHost(current.url) || isPrivateOrAuthHost(landedUrl)) {
            throw new CaptureError(
              'PRIVATE_SITE',
              `Target site returned HTTP ${status} and appears to be a private preview or login-protected workspace.`,
            );
          }

          // Try SSRF-validated standard HTTP fetch in case only headless Chromium TLS fingerprint was rejected
          let fallbackRecovered = false;
          try {
            const { response: fbRes, finalUrl: fbUrl } = await safeFetchWithRedirectValidation(
              current.url,
              {
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
                  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
              },
              5,
              validatedHostCache,
            );
            const fbCt = (fbRes.headers.get('content-type') || '').toLowerCase();
            if (fbRes.ok && fbCt.includes('text/html') && !isPrivateOrAuthHost(fbUrl)) {
              const fbHtml = await fbRes.text();
              const $fbProbe = cheerio.load(fbHtml);
              $fbProbe('script, style, noscript, template').remove();
              const visibleTextLen = $fbProbe('body').text().replace(/\s+/g, ' ').trim().length;
              const looksLikeChallenge =
                fbRes.headers.get('cf-mitigated') === 'challenge' ||
                /Just a moment\.\.\.|Enable JavaScript and cookies to continue/i.test(fbHtml);
              if (fbHtml.trim().length > 120 && !looksLikeChallenge) {
                partialHtml = fbHtml;
              }
              if (visibleTextLen >= 80 && !looksLikeChallenge) {
                const fbOrigin = new URL(fbUrl).origin;
                const $fb = cheerio.load(fbHtml);
                const subAssetTargets: Array<{ url: string; resourceType: string }> = [];
                $fb('link[rel="stylesheet"][href], script[src], img[src]').each((_, el) => {
                  if (subAssetTargets.length >= 60) return;
                  const rawRef = ($fb(el).attr('href') || $fb(el).attr('src') || '').trim();
                  if (!rawRef || rawRef.startsWith('data:') || rawRef.startsWith('blob:')) return;
                  try {
                    const resolved = new URL(rawRef, fbUrl);
                    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
                    const tag = 'tagName' in el ? el.tagName?.toLowerCase() : '';
                    const rType = tag === 'link' ? 'stylesheet' : tag === 'script' ? 'script' : 'image';
                    if (rType === 'image' && !job.options.includeImages) return;
                    subAssetTargets.push({ url: resolved.toString(), resourceType: rType });
                  } catch {
                    // Skip invalid asset URL
                  }
                });

                await Promise.allSettled(
                  subAssetTargets.map(async (item) => {
                    try {
                      const { response: aRes, finalUrl: aFinal } =
                        await safeFetchWithRedirectValidation(item.url, {}, 3, validatedHostCache);
                      if (!aRes.ok) return;
                      const aNorm = normalizeUrlKey(aFinal);
                      if (assets.has(aNorm)) return;
                      const aCt = aRes.headers.get('content-type') || '';
                      const cat = classifyAsset(aFinal, aCt, item.resourceType);
                      if (!cat) return;
                      const arrBuf = await aRes.arrayBuffer();
                      const buf = Buffer.from(arrBuf);
                      if (buf.length === 0 || totalFiles + 1 > MAX_FILES || totalBytes + buf.length > MAX_TOTAL_BYTES) {
                        return;
                      }
                      const localRelPath = buildAssetRelPath(aFinal, cat, aCt, usedPaths);
                      totalFiles += 1;
                      totalBytes += buf.length;
                      assets.set(aNorm, {
                        originalUrl: aFinal,
                        normalizedUrl: aNorm,
                        localRelPath,
                        category: cat,
                        contentType: aCt,
                        buffer: buf,
                      });
                      if (cat === 'css') stats.cssCount += 1;
                      else if (cat === 'js') stats.jsCount += 1;
                      else if (cat === 'images') stats.imagesCount += 1;
                      else if (cat === 'fonts') stats.fontsCount += 1;
                      else stats.otherAssetsCount += 1;
                      stats.assetsCaptured = assets.size;
                      stats.totalBytes = totalBytes;
                    } catch {
                      // Ignore individual asset fetch failures
                    }
                  }),
                );

                const localRelPath = buildPageRelPath(fbUrl, entryNormalized, usedPaths);
                const htmlBytes = Buffer.byteLength(fbHtml, 'utf8');
                if (consumeBudget(htmlBytes, 1)) {
                  const title = $fb('title').first().text().trim() || new URL(fbUrl).hostname || fbOrigin;
                  pages.push({
                    originalUrl: fbUrl,
                    normalizedUrl: normalizeUrlKey(fbUrl),
                    localRelPath,
                    html: fbHtml,
                    title,
                  });
                  job.siteTitle = title;
                  stats.pagesCaptured = pages.length;
                  stats.htmlCount = pages.length;
                  fallbackRecovered = true;
                  httpFallbackUsed = true;
                }
              }
            }
          } catch {
            // Fall through to ACCESS_DENIED
          }

          if (!fallbackRecovered) {
            throw new CaptureError(
              'ACCESS_DENIED',
              `Target site returned HTTP ${status}. Its firewall, bot protection, or access controls denied the request.`,
            );
          }
        } else {
          throw new CaptureError(
            'NAVIGATION_ERROR',
            `Target site returned HTTP ${status} (${mainResponse.statusText() || 'Error'}).`,
          );
        }
      }

      if (httpFallbackUsed) {
        break;
      }

      if (pages.length === 0 && !isPrivateOrAuthHost(current.url) && isPrivateOrAuthHost(landedUrl)) {
        throw new CaptureError(
          'PRIVATE_SITE',
          `Target site redirected to a login or authentication page (${new URL(landedUrl).hostname}). SiteGrab does not bypass authentication.`,
        );
      }

      checkAborted();
      if (fatalLimitError) throw fatalLimitError;

      // Verify final URL after any client/server redirects
      const finalPageUrl = landedUrl;
      await validateExternalUrl(finalPageUrl, validatedHostCache);

      // Allow client-rendered SPAs a brief moment to mount visible content if DOM is initially sparse
      await page
        .waitForFunction(
          () => (document.body?.innerText?.trim().length || 0) >= 40,
          undefined,
          { timeout: 3500 },
        )
        .catch(() => {});

      // Scroll page quickly to trigger lazy-loaded images & chunks
      await page.evaluate(async () => {
        const scrollStep = Math.max(700, Math.floor(window.innerHeight));
        const maxScroll = Math.min(document.body.scrollHeight || 0, 9000);
        for (let y = 0; y <= maxScroll; y += scrollStep) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 65));
        }
        window.scrollTo(0, 0);
      });

      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      await Promise.allSettled(pendingAssetReads.splice(0));

      checkAborted();
      if (fatalLimitError) throw fatalLimitError;

      const localRelPath = buildPageRelPath(current.url, entryNormalized, usedPaths);

      // Capture comparison screenshot of entry page (stored in tempRoot for Original vs. Captured view)
      if (pages.length === 0) {
        try {
          await page.screenshot({
            path: job.originalScreenshotPath,
            fullPage: false,
            type: 'png',
          });
          job.hasOriginalScreenshot = true;
        } catch {
          job.hasOriginalScreenshot = false;
        }
      }

      // Optionally save full-page screenshots into exported project
      if (job.options.saveScreenshots) {
        try {
          const shotRel = `screenshots/${localRelPath.replace(/\.html$/i, '').replace(/\//g, '_')}.png`;
          const shotDest = path.resolve(job.siteDir, shotRel);
          if (shotDest.startsWith(job.siteDir + path.sep)) {
            const shotBuf = await page.screenshot({ fullPage: true, type: 'png' });
            if (consumeBudget(shotBuf.length, 1)) {
              await fs.mkdir(path.dirname(shotDest), { recursive: true });
              await fs.writeFile(shotDest, shotBuf);
              stats.screenshotsCount += 1;
            }
          }
        } catch {
          // Non-fatal screenshot error
        }
      }

      // Inspect broken images in the rendered DOM
      if (job.options.includeImages) {
        const pageBrokenImgs = await page
          .evaluate(() => {
            return Array.from(document.querySelectorAll('img'))
              .filter((img) => {
                const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
                if (!src) return false;
                return !img.complete || img.naturalWidth === 0;
              })
              .map((img) => ({
                src: img.getAttribute('src') || img.getAttribute('data-src') || '',
                reason: !img.complete ? 'Image did not finish loading' : 'Image decoded with zero width (broken or blocked)',
              }));
          })
          .catch(() => []);

        for (const bImg of pageBrokenImgs) {
          if (brokenImages.length < 50) {
            brokenImages.push({ ...bImg, page: localRelPath });
          }
        }
      }

      const html = await page.content();
      const title = (await page.title().catch(() => '')) || currentParsed.hostname;

      if (pages.length === 0) {
        const probe = await page
          .evaluate(() => {
            const txt = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const visualCount = document.querySelectorAll('img, svg, canvas, video').length;
            return { len: txt.length, snippet: txt.slice(0, 600), visualCount };
          })
          .catch(() => ({ len: 0, snippet: '', visualCount: 0 }));

        const isChallengePage =
          /Just a moment\.\.\.|Attention Required! \| Cloudflare|Checking your browser before accessing|Enable JavaScript and cookies to continue|Verify you are human/i.test(
            `${title} ${probe.snippet}`,
          );

        if (isChallengePage) {
          throw new CaptureError(
            'ACCESS_DENIED',
            'Target website presented a browser verification challenge instead of page content.',
          );
        }

        if (probe.len < 25 && probe.visualCount < 2) {
          throw new CaptureError(
            'NAVIGATION_ERROR',
            'Target page rendered empty content in headless browser.',
          );
        }
      }

      const htmlBytes = Buffer.byteLength(html, 'utf8');
      if (!consumeBudget(htmlBytes, 1)) {
        if (totalFiles + 1 > MAX_FILES) {
          throw new CaptureError('FILE_LIMIT_EXCEEDED', `Site exceeds ${MAX_FILES} files limit.`);
        }
        throw new CaptureError('SIZE_LIMIT_EXCEEDED', 'Site exceeds 100 MB capture limit.');
      }

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
      stats.htmlCount = pages.length;

      // Enqueue internal links if within depth limit
      if (current.depth < maxDepth && pages.length < maxPages) {
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map(
            (a) => (a as HTMLAnchorElement).getAttribute('href') || '',
          ),
        );

        for (const rawHref of hrefs) {
          if (
            !rawHref ||
            rawHref.startsWith('#') ||
            rawHref.startsWith('mailto:') ||
            rawHref.startsWith('tel:') ||
            rawHref.startsWith('javascript:')
          ) {
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

    for (const pg of pages) {
      checkAborted();
      const destPath = path.resolve(job.siteDir, pg.localRelPath);
      if (!destPath.startsWith(job.siteDir + path.sep)) continue;

      await fs.mkdir(path.dirname(destPath), { recursive: true });

      const rewritten = rewriteHtmlDocument({
        html: pg.html,
        pageOriginalUrl: pg.originalUrl,
        pageLocalRelPath: pg.localRelPath,
        assetPathMap,
        pagePathMap,
        preserveInternalNav: job.options.preserveInternalNav,
      });

      for (const item of rewritten.unresolvedLinks) {
        if (unresolvedLinks.length < 100) {
          unresolvedLinks.push(item);
        }
      }

      let finalHtml = rewritten.html;
      if (job.options.formatCode) {
        finalHtml = await formatCapturedCode(finalHtml, 'html');
      }

      await fs.writeFile(destPath, finalHtml, 'utf8');
    }

    stats.durationMs = Math.max(1, Date.now() - startTime);

    // 8. Generate VS Code workspace config, package.json & README.md
    await writeArchiveWorkspaceConfig(job.siteDir);

    let hasPackageJson = false;
    hasPackageJson = await writeArchivePackageJson({
      siteDir: job.siteDir,
      hostname: job.hostname,
      siteTitle: job.siteTitle,
    });

    await writeArchiveReadme({
      siteDir: job.siteDir,
      targetUrl: job.url,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: job.options.recoverSourceMaps,
      hasPackageJson,
      captureMode: 'live',
    });

    checkAborted();

    // Populate diagnostics & generated folder contents
    job.captureMode = 'live';
    job.diagnostics = {
      brokenImages,
      failedResources,
      unresolvedLinks,
    };
    job.files = await listDirectoryFiles(job.siteDir);

    // 9. Zip folder inside a clean named root directory
    emit('zipping', 'Compressing site archive into VS Code-ready ZIP...', 93);
    const rootFolderName = path.basename(job.zipFilename, '.zip') || `sitegrab-${job.hostname}`;
    const zipBytes = await createZipArchive(job.siteDir, job.zipPath, rootFolderName);
    if (!zipBytes || zipBytes <= 0) {
      throw new CaptureError('CAPTURE_FAILED', 'Generated ZIP archive was empty.');
    }
    stats.zipBytes = zipBytes;
    stats.durationMs = Math.max(1, Date.now() - startTime);

    emit('ready', 'Snapshot complete. Preview your files or click Download ZIP when ready.', 100);
  } catch (err) {
    const captureErr =
      err instanceof CaptureError
        ? err
        : err instanceof SsrfValidationError
          ? new CaptureError(err.code, err.message)
          : timedOut
            ? new CaptureError(
                'TIMEOUT',
                `Capture timed out after ${Math.round(effectiveTimeoutMs / 1000)} seconds.`,
              )
            : new CaptureError(
                'CAPTURE_FAILED',
                err instanceof Error ? err.message : 'An unexpected error occurred during capture.',
              );

    // Preserve any partially rendered HTML or screenshot from Playwright before closing browser
    if (context && !partialHtml) {
      try {
        const openPages = context.pages();
        if (openPages.length > 0) {
          const p = openPages[0];
          const maybeHtml = await p.content().catch(() => '');
          if (maybeHtml && maybeHtml.length > 150 && !/Just a moment\.\.\./i.test(maybeHtml)) {
            partialHtml = maybeHtml;
            partialScreenshot = await p.screenshot({ type: 'png' }).catch(() => null);
          }
        }
      } catch {
        // Ignore partial capture errors
      }
    }

    // Close Playwright resources immediately before any fallback generation
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }

    const NON_CLONABLE_CODES = new Set([
      'INVALID_URL',
      'INVALID_SCHEME',
      'BLOCKED_ADDRESS',
      'ROBOTS_DISALLOWED',
      'PRIVATE_SITE',
      'ABORTED',
    ]);

    if (!NON_CLONABLE_CODES.has(captureErr.code)) {
      try {
        emit(
          'capturing',
          'Direct capture hit an error — building a complete interactive website clone...',
          68,
          captureErr.message,
        );
        await generateCloneFallbackForUrl({
          targetUrl: job.url,
          failureReason: captureErr.message,
          partialHtml: partialHtml || undefined,
          partialScreenshot,
          validatedHostCache,
          job,
          stats,
        });
        emit(
          'ready',
          'Website build complete. Preview your files or click Download ZIP when ready.',
          100,
          captureErr.message,
        );
        return;
      } catch {
        // If fallback cloning also fails (e.g. missing API key), propagate original error cleanly
      }
    }

    throw captureErr;
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
