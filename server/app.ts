import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { resolveChromiumExecutablePath } from './playwrightExec.ts';
import {
  AiServiceError,
  isEditableTextFile,
  resolveSafeSiteFile,
  runAiCodeAssistant,
  type AiFileEdit,
} from './ai.ts';
import {
  clearPreviewCookie,
  getPreviewSessionUid,
  issueJobPreviewToken,
  issuePreviewCookie,
  requireAuth,
  verifyJobPreviewToken,
  verifySameOriginRequest,
} from './auth.ts';
import { CaptureError, runCaptureJob } from './capture.ts';
import {
  addFeedbackEntry,
  FeedbackValidationError,
  getFeedbackSummary,
} from './feedback.ts';
import { formatCapturedCode } from './formatter.ts';
import { ENHANCED_INTERACTION_JS, SANDBOX_COMPAT_HEAD_SHIM } from './generatedSiteRepair.ts';
import { IpRateLimiter } from './rateLimit.ts';
import { normalizeAndParseUrl, SsrfValidationError, validateExternalUrl } from './ssrf.ts';
import type {
  CaptureJob,
  CaptureOptions,
  CaptureStage,
  CaptureStats,
  CaptureStrategy,
  ProgressEvent,
  WaitStrategy,
} from './types.ts';
import {
  detectImageMimeType,
  generateWebsiteFromScreenshot,
  MAX_UPLOAD_SCREENSHOT_BYTES,
  ScreenshotGenError,
} from './screenshotGen.ts';
import { MAX_UPLOAD_ZIP_BYTES, processImportedZip, ZipImportError } from './zipImport.ts';
import { createZipArchive, listDirectoryFiles } from './zipper.ts';

const JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours retention for preview, AI editing, and ZIP download
const CLEANUP_INTERVAL_MS = 60 * 1000;
const BUNDLE_MAX_FILES = 40;
const BUNDLE_MAX_BYTES = 600_000;
const BUNDLE_MAX_SINGLE_FILE_BYTES = 450_000;
const BUNDLE_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.svg', '.json', '.md']);

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.md': 'text/markdown; charset=utf-8',
};

export function createSiteGrabServer(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  const jobs = new Map<string, CaptureJob>();
  const rateLimiter = new IpRateLimiter(20, 10 * 60 * 1000);
  const zipImportLimiter = new IpRateLimiter(25, 10 * 60 * 1000);
  const screenshotLimiter = new IpRateLimiter(20, 10 * 60 * 1000);
  const feedbackLimiter = new IpRateLimiter(15, 10 * 60 * 1000);

  async function cleanupJobFiles(job: CaptureJob): Promise<void> {
    if (job.cleaned) return;
    job.cleaned = true;
    try {
      await fsp.rm(job.tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  async function saveJobMetaToDisk(job: CaptureJob): Promise<void> {
    if (job.cleaned || job.status !== 'ready') return;
    try {
      await fsp.mkdir(job.tempRoot, { recursive: true });
      const metaPath = path.join(job.tempRoot, '_sitegrab_meta.json');
      const meta = {
        id: job.id,
        ownerUid: job.ownerUid,
        url: job.url,
        hostname: job.hostname,
        siteTitle: job.siteTitle,
        siteDir: job.siteDir,
        zipPath: job.zipPath,
        zipFilename: job.zipFilename,
        captureMode: job.captureMode,
        fallbackReason: job.fallbackReason,
        hasOriginalScreenshot: job.hasOriginalScreenshot,
        options: job.options,
        stats: job.lastEvent.stats,
        diagnostics: job.diagnostics,
        lastEvent: job.lastEvent,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
      };
      await fsp.writeFile(metaPath, JSON.stringify(meta), 'utf8');
    } catch {
      // Non-fatal metadata write failure
    }
  }

  async function loadOrGetJob(jobId: string): Promise<CaptureJob | undefined> {
    const existing = jobs.get(jobId);
    if (existing) return existing;
    if (!/^[a-zA-Z0-9_-]{4,128}$/.test(jobId)) return undefined;

    const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
    const metaPath = path.join(tempRoot, '_sitegrab_meta.json');
    try {
      const raw = await fsp.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as Partial<CaptureJob> & {
        stats?: CaptureStats;
      };
      if (!meta.ownerUid || !meta.zipFilename) {
        return undefined;
      }
      const siteDir = path.join(tempRoot, 'site');
      const zipPath = path.join(tempRoot, path.basename(meta.zipFilename));
      const files = await listDirectoryFiles(siteDir);
      if (files.length === 0) return undefined;

      const restoredJob: CaptureJob = {
        id: jobId,
        ownerUid: meta.ownerUid,
        url: meta.url || `https://${meta.hostname || 'site'}`,
        hostname: meta.hostname || 'site',
        siteTitle: meta.siteTitle || meta.hostname || 'Captured Site',
        options: meta.options!,
        status: 'ready',
        lastEvent: meta.lastEvent || {
          jobId,
          stage: 'ready',
          message: 'Workspace restored.',
          percent: 100,
          stats: meta.stats!,
          files,
          diagnostics: meta.diagnostics,
          hasOriginalScreenshot: Boolean(meta.hasOriginalScreenshot),
          captureMode: meta.captureMode,
          fallbackReason: meta.fallbackReason,
        },
        tempRoot,
        siteDir,
        zipPath,
        zipFilename: path.basename(meta.zipFilename),
        originalScreenshotPath:
          meta.originalScreenshotPath || path.join(tempRoot, '_original-preview.png'),
        hasOriginalScreenshot: Boolean(meta.hasOriginalScreenshot),
        captureMode: meta.captureMode,
        fallbackReason: meta.fallbackReason,
        files,
        diagnostics: meta.diagnostics || {
          brokenImages: [],
          failedResources: [],
          unresolvedLinks: [],
        },
        createdAt: meta.createdAt || Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
        cleaned: false,
        subscribers: new Set(),
      };
      jobs.set(jobId, restoredJob);
      return restoredJob;
    } catch {
      return undefined;
    }
  }

  // Periodic sweep of expired temp directories and rate limit buckets
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    rateLimiter.prune();
    zipImportLimiter.prune();
    screenshotLimiter.prune();
    feedbackLimiter.prune();
    for (const [id, job] of jobs.entries()) {
      if (now > job.expiresAt) {
        void cleanupJobFiles(job);
        jobs.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  sweepTimer.unref();

  app.get('/api/health', (_req: Request, res: Response) => {
    const chromiumInstalled = Boolean(resolveChromiumExecutablePath());
    res.json({
      ok: true,
      service: 'sitegrab',
      chromiumInstalled,
      aiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
    });
  });

  app.get('/api/feedback', async (_req: Request, res: Response) => {
    try {
      const summary = await getFeedbackSummary();
      res.json(summary);
    } catch {
      res.status(500).json({ error: 'Failed to load feedback.' });
    }
  });

  app.post('/api/feedback', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const limitResult = feedbackLimiter.check(clientIp);
    if (!limitResult.allowed) {
      res.setHeader('Retry-After', String(limitResult.retryAfterSeconds));
      res.status(429).json({
        error: `Feedback rate limit reached. Please wait ${limitResult.retryAfterSeconds} seconds before submitting again.`,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await addFeedbackEntry({
        authorName: body.authorName,
        rating: body.rating,
        category: body.category,
        experience: body.experience,
        suggestion: body.suggestion,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof FeedbackValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Failed to save feedback.' });
    }
  });

  app.post('/api/auth/preview-session', requireAuth, (req: Request, res: Response) => {
    if (!verifySameOriginRequest(req)) {
      res.status(403).json({ error: 'Cross-origin preview session request rejected.' });
      return;
    }
    issuePreviewCookie(res, req, req.authUser!.uid);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    if (!verifySameOriginRequest(req)) {
      res.status(403).json({ error: 'Cross-origin logout request rejected.' });
      return;
    }
    clearPreviewCookie(res, req);
    res.json({ ok: true });
  });

  app.post('/api/capture', requireAuth, async (req: Request, res: Response) => {
    const ownerUid = req.authUser!.uid;
    const limitResult = rateLimiter.check(ownerUid);
    if (!limitResult.allowed) {
      res.setHeader('Retry-After', String(limitResult.retryAfterSeconds));
      res.status(429).json({
        errorCode: 'RATE_LIMITED',
        error: `Rate limit reached (20 captures per 10 minutes). Please wait ${limitResult.retryAfterSeconds} seconds and try again.`,
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
      return;
    }

    const body = req.body as Partial<CaptureOptions> | undefined;
    const rawUrl = typeof body?.url === 'string' ? body.url : '';

    let parsedUrl: URL;
    try {
      parsedUrl = normalizeAndParseUrl(rawUrl);
      // Fast preliminary SSRF check before creating job
      await validateExternalUrl(parsedUrl.toString());
    } catch (err) {
      const code = err instanceof SsrfValidationError ? err.code : 'INVALID_URL';
      const message = err instanceof Error ? err.message : 'Invalid URL provided.';
      res.status(400).json({ errorCode: code, error: message });
      return;
    }

    const rawWaitStrategy = body?.waitStrategy;
    const waitStrategy: WaitStrategy =
      rawWaitStrategy === 'networkidle' || rawWaitStrategy === 'domcontentloaded'
        ? rawWaitStrategy
        : 'load';

    const requestedTimeout = Number(body?.timeoutMs ?? 60_000);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(15_000, Math.min(120_000, requestedTimeout))
      : 60_000;

    const rawStrategy = body?.captureStrategy;
    const captureStrategy: CaptureStrategy =
      rawStrategy === 'clone' || rawStrategy === 'live' ? rawStrategy : 'auto';

    const options: CaptureOptions = {
      url: parsedUrl.toString(),
      crawlDepth: Math.max(0, Math.min(3, Number(body?.crawlDepth ?? 0) || 0)),
      maxPages: Math.max(1, Math.min(25, Number(body?.maxPages ?? 5) || 5)),
      formatCode: body?.formatCode !== false,
      recoverSourceMaps: body?.recoverSourceMaps !== false,
      respectRobots: true, // Always enforce robots.txt compliance
      includeImages: body?.includeImages !== false,
      includeFonts: body?.includeFonts !== false,
      mobileViewport: body?.mobileViewport === true,
      saveScreenshots: body?.saveScreenshots === true,
      preserveInternalNav: body?.preserveInternalNav !== false,
      captureStrategy,
      timeoutMs,
      waitStrategy,
    };

    const jobId = crypto.randomUUID();
    const safeHost = parsedUrl.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
    const siteDir = path.join(tempRoot, 'site');
    const zipFilename = `sitegrab-${safeHost}.zip`;
    const zipPath = path.join(tempRoot, zipFilename);
    const originalScreenshotPath = path.join(tempRoot, '_original-preview.png');

    const stats: CaptureStats = {
      pagesCaptured: 0,
      assetsCaptured: 0,
      htmlCount: 0,
      cssCount: 0,
      jsCount: 0,
      imagesCount: 0,
      fontsCount: 0,
      otherAssetsCount: 0,
      totalBytes: 0,
      sourceMapsRecovered: 0,
      skippedRobots: 0,
      failedAssetsCount: 0,
      screenshotsCount: 0,
      durationMs: 0,
    };

    const initialEvent: ProgressEvent = {
      jobId,
      stage: 'queued',
      message: 'Job queued...',
      percent: 2,
      stats: { ...stats },
    };

    const job: CaptureJob = {
      id: jobId,
      ownerUid,
      url: options.url,
      hostname: parsedUrl.hostname,
      siteTitle: parsedUrl.hostname,
      options,
      status: 'queued',
      lastEvent: initialEvent,
      tempRoot,
      siteDir,
      zipPath,
      zipFilename,
      originalScreenshotPath,
      hasOriginalScreenshot: false,
      files: [],
      diagnostics: {
        brokenImages: [],
        failedResources: [],
        unresolvedLinks: [],
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + JOB_TTL_MS,
      cleaned: false,
      subscribers: new Set(),
    };

    jobs.set(jobId, job);

    const emit = (
      stage: CaptureStage,
      message: string,
      percent: number,
      detail?: string,
      errorCode?: string,
    ) => {
      job.status = stage;
      const evt: ProgressEvent = {
        jobId,
        stage,
        message,
        percent,
        detail,
        stats: { ...stats },
        ...(stage === 'ready'
          ? {
              files: job.files,
              diagnostics: job.diagnostics,
              hasOriginalScreenshot: job.hasOriginalScreenshot,
              captureMode: job.captureMode,
              fallbackReason: job.fallbackReason,
            }
          : {}),
        errorCode,
      };
      job.lastEvent = evt;
      for (const subscriber of job.subscribers) {
        subscriber(evt);
      }
    };

    // Start capture asynchronously so SSE client can attach immediately
    void (async () => {
      try {
        await runCaptureJob(job, emit, stats);
        if (job.status === 'ready') {
          await saveJobMetaToDisk(job);
        }
      } catch (err) {
        const code = err instanceof CaptureError ? err.code : 'CAPTURE_FAILED';
        const msg = err instanceof Error ? err.message : 'Capture failed.';
        emit('error', msg, job.lastEvent.percent, undefined, code);
        await cleanupJobFiles(job);
      }
    })();

    res.status(202).json({
      jobId,
      url: job.url,
      hostname: job.hostname,
      remainingQuota: limitResult.remaining,
    });
  });

  // Upload & extract an authorized website ZIP (Bolt, Lovable, etc.) using SiteGrab processing
  app.post(
    '/api/capture/import-zip',
    requireAuth,
    express.raw({
      type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
      limit: `${MAX_UPLOAD_ZIP_BYTES}b`,
    }),
    async (req: Request, res: Response) => {
      const ownerUid = req.authUser!.uid;
      const limitResult = zipImportLimiter.check(ownerUid);
      if (!limitResult.allowed) {
        res.setHeader('Retry-After', String(limitResult.retryAfterSeconds));
        res.status(429).json({
          errorCode: 'RATE_LIMITED',
          error: `ZIP import limit reached. Please wait ${limitResult.retryAfterSeconds} seconds before uploading again.`,
        });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({
          errorCode: 'INVALID_ZIP',
          error: 'No ZIP file received. Please select a valid .zip archive.',
        });
        return;
      }

      const rawName = String(req.get('x-zip-filename') || 'imported-site.zip');
      const safeOriginalName =
        path
          .basename(rawName)
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(0, 80) || 'imported-site.zip';
      const baseSlug =
        safeOriginalName.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9.-]/g, '-') || 'imported-site';

      const jobId = crypto.randomUUID();
      const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
      const siteDir = path.join(tempRoot, 'site');
      const zipFilename = `sitegrab-${baseSlug}.zip`;
      const zipPath = path.join(tempRoot, zipFilename);

      const options: CaptureOptions = {
        url: `zip://${safeOriginalName}`,
        crawlDepth: 0,
        maxPages: 1,
        formatCode: req.get('x-format-code') !== 'false',
        recoverSourceMaps: false,
        respectRobots: true,
        includeImages: req.get('x-include-images') !== 'false',
        includeFonts: req.get('x-include-fonts') !== 'false',
        mobileViewport: false,
        saveScreenshots: false,
        preserveInternalNav: req.get('x-preserve-nav') !== 'false',
      };

      const stats: CaptureStats = {
        pagesCaptured: 0,
        assetsCaptured: 0,
        htmlCount: 0,
        cssCount: 0,
        jsCount: 0,
        imagesCount: 0,
        fontsCount: 0,
        otherAssetsCount: 0,
        totalBytes: 0,
        sourceMapsRecovered: 0,
        skippedRobots: 0,
        failedAssetsCount: 0,
        screenshotsCount: 0,
        durationMs: 0,
      };

      const readyEvent: ProgressEvent = {
        jobId,
        stage: 'ready',
        message: 'ZIP project extracted and ready for preview, AI inspection, or download.',
        percent: 100,
        stats,
      };

      const job: CaptureJob = {
        id: jobId,
        ownerUid,
        url: options.url,
        hostname: baseSlug,
        siteTitle: baseSlug,
        options,
        status: 'ready',
        lastEvent: readyEvent,
        tempRoot,
        siteDir,
        zipPath,
        zipFilename,
        originalScreenshotPath: path.join(tempRoot, '_original-preview.png'),
        hasOriginalScreenshot: false,
        files: [],
        diagnostics: {
          brokenImages: [],
          failedResources: [],
          unresolvedLinks: [],
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
        cleaned: false,
        subscribers: new Set(),
      };

      try {
        await processImportedZip({
          zipBuffer: req.body,
          originalZipName: safeOriginalName,
          job,
          stats,
        });
        job.lastEvent = {
          ...readyEvent,
          stats: { ...stats },
          files: job.files,
          diagnostics: job.diagnostics,
          hasOriginalScreenshot: false,
          captureMode: job.captureMode,
        };
        jobs.set(jobId, job);
        await saveJobMetaToDisk(job);
        res.status(201).json({
          jobId,
          url: job.url,
          hostname: job.hostname,
          siteTitle: job.siteTitle,
          zipFilename: job.zipFilename,
          previewToken: issueJobPreviewToken(ownerUid, jobId),
          event: job.lastEvent,
        });
      } catch (err) {
        await cleanupJobFiles(job);
        if (err instanceof ZipImportError) {
          res.status(err.statusCode).json({ errorCode: err.code, error: err.message });
          return;
        }
        res.status(500).json({
          errorCode: 'INVALID_ZIP',
          error: 'Could not extract the uploaded ZIP archive.',
        });
      }
    },
  );

  // Generate a complete static website & VS Code ZIP directly from a website screenshot
  app.post(
    '/api/capture/from-screenshot',
    requireAuth,
    express.raw({
      type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream'],
      limit: `${MAX_UPLOAD_SCREENSHOT_BYTES}b`,
    }),
    async (req: Request, res: Response) => {
      const ownerUid = req.authUser!.uid;
      const limitResult = screenshotLimiter.check(ownerUid);
      if (!limitResult.allowed) {
        res.setHeader('Retry-After', String(limitResult.retryAfterSeconds));
        res.status(429).json({
          errorCode: 'RATE_LIMITED',
          error: `Screenshot generation limit reached. Please wait ${limitResult.retryAfterSeconds} seconds before uploading again.`,
        });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({
          errorCode: 'INVALID_IMAGE',
          error: 'No screenshot image received. Please upload a PNG, JPEG, WebP, or GIF image.',
        });
        return;
      }

      const rawName = String(req.get('x-screenshot-filename') || 'screenshot.png');
      const safeOriginalName =
        path
          .basename(rawName)
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(0, 80) || 'screenshot.png';
      const baseSlug =
        safeOriginalName
          .replace(/\.(png|jpe?g|webp|gif)$/i, '')
          .replace(/[^a-zA-Z0-9.-]/g, '-') || 'screenshot-site';

      const notes = String(req.get('x-screenshot-notes') || '').slice(0, 1200);

      const jobId = crypto.randomUUID();
      const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
      const siteDir = path.join(tempRoot, 'site');
      const zipFilename = `sitegrab-${baseSlug}.zip`;
      const zipPath = path.join(tempRoot, zipFilename);

      const options: CaptureOptions = {
        url: `screenshot://${safeOriginalName}`,
        crawlDepth: 0,
        maxPages: 1,
        formatCode: req.get('x-format-code') !== 'false',
        recoverSourceMaps: false,
        respectRobots: true,
        includeImages: true,
        includeFonts: true,
        mobileViewport: false,
        saveScreenshots: false,
        preserveInternalNav: true,
      };

      const stats: CaptureStats = {
        pagesCaptured: 0,
        assetsCaptured: 0,
        htmlCount: 0,
        cssCount: 0,
        jsCount: 0,
        imagesCount: 0,
        fontsCount: 0,
        otherAssetsCount: 0,
        totalBytes: 0,
        sourceMapsRecovered: 0,
        skippedRobots: 0,
        failedAssetsCount: 0,
        screenshotsCount: 0,
        durationMs: 0,
      };

      const readyEvent: ProgressEvent = {
        jobId,
        stage: 'ready',
        message: 'Website generated from screenshot and ready for preview, AI refinement, or ZIP download.',
        percent: 100,
        stats,
      };

      const job: CaptureJob = {
        id: jobId,
        ownerUid,
        url: options.url,
        hostname: baseSlug,
        siteTitle: baseSlug,
        options,
        status: 'ready',
        lastEvent: readyEvent,
        tempRoot,
        siteDir,
        zipPath,
        zipFilename,
        originalScreenshotPath: path.join(tempRoot, '_original-preview.png'),
        hasOriginalScreenshot: false,
        files: [],
        diagnostics: {
          brokenImages: [],
          failedResources: [],
          unresolvedLinks: [],
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
        cleaned: false,
        subscribers: new Set(),
      };

      try {
        await generateWebsiteFromScreenshot({
          imageBuffer: req.body,
          originalFilename: safeOriginalName,
          notes,
          job,
          stats,
        });
        job.lastEvent = {
          ...readyEvent,
          stats: { ...stats },
          files: job.files,
          diagnostics: job.diagnostics,
          hasOriginalScreenshot: job.hasOriginalScreenshot,
          captureMode: job.captureMode,
        };
        jobs.set(jobId, job);
        await saveJobMetaToDisk(job);
        res.status(201).json({
          jobId,
          url: job.url,
          hostname: job.hostname,
          siteTitle: job.siteTitle,
          zipFilename: job.zipFilename,
          previewToken: issueJobPreviewToken(ownerUid, jobId),
          event: job.lastEvent,
        });
      } catch (err) {
        await cleanupJobFiles(job);
        if (err instanceof ScreenshotGenError) {
          res.status(err.statusCode).json({ errorCode: err.code, error: err.message });
          return;
        }
        res.status(500).json({
          errorCode: 'CAPTURE_FAILED',
          error: 'Could not generate website from the uploaded screenshot.',
        });
      }
    },
  );

  app.get('/api/capture/:jobId/events', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.status(404).json({ error: 'Capture job not found or expired.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      job.subscribers.delete(sendEvent);
    };

    const safeWrite = (chunk: string): boolean => {
      if (closed || res.writableEnded || res.destroyed) return false;
      try {
        res.write(chunk);
        return true;
      } catch {
        cleanup();
        return false;
      }
    };

    const sendEvent = (evt: ProgressEvent) => {
      if (!safeWrite(`data: ${JSON.stringify(evt)}\n\n`)) {
        return;
      }
      if (evt.stage === 'ready' || evt.stage === 'error') {
        cleanup();
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    // Initial SSE comment flushes headers through proxies immediately
    safeWrite(': connected\n\n');
    sendEvent(job.lastEvent);
    if (job.status === 'ready' || job.status === 'error') {
      return;
    }

    job.subscribers.add(sendEvent);
    heartbeatTimer = setInterval(() => {
      if (!safeWrite(': keepalive\n\n')) {
        cleanup();
      }
    }, 8000);
    heartbeatTimer.unref?.();

    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.get('/api/capture/:jobId/status', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.status(404).json({ error: 'Capture job not found or expired.' });
      return;
    }
    job.expiresAt = Date.now() + JOB_TTL_MS;
    res.json({
      ...job.lastEvent,
      siteTitle: job.siteTitle,
      hostname: job.hostname,
      zipFilename: job.zipFilename,
      previewToken: issueJobPreviewToken(req.authUser!.uid, job.id),
      files: job.files,
      diagnostics: job.diagnostics,
      hasOriginalScreenshot: job.hasOriginalScreenshot,
      captureMode: job.captureMode,
      fallbackReason: job.fallbackReason,
      cleaned: job.cleaned,
    });
  });

  // Export lightweight previewable source files so client can persist history previews in Firestore
  app.get('/api/capture/:jobId/bundle', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).json({ error: 'Capture workspace unavailable.' });
      return;
    }

    const scorePriority = (relPath: string): number => {
      if (relPath === 'index.html') return 0;
      if (relPath.endsWith('.css')) return 1;
      if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) return 2;
      if (relPath.endsWith('.html') || relPath.endsWith('.htm')) return 3;
      if (relPath.endsWith('.svg')) return 4;
      if (relPath === 'package.json' || relPath.toLowerCase() === 'readme.md') return 5;
      return 6;
    };

    const sortedCandidates = [...job.files]
      .filter((f) => {
        if (f.path.startsWith('.vscode/')) return false;
        const ext = path.posix.extname(f.path).toLowerCase();
        return BUNDLE_EXTS.has(ext) && f.size > 0 && f.size <= BUNDLE_MAX_SINGLE_FILE_BYTES;
      })
      .sort((a, b) => scorePriority(a.path) - scorePriority(b.path) || a.size - b.size);

    const bundledFiles: Array<{ path: string; content: string }> = [];
    let totalBytes = 0;

    for (const candidate of sortedCandidates) {
      if (bundledFiles.length >= BUNDLE_MAX_FILES) break;
      try {
        const resolved = resolveSafeSiteFile(job.siteDir, candidate.path);
        const content = await fsp.readFile(resolved, 'utf8');
        const byteLen = Buffer.byteLength(content, 'utf8');
        if (byteLen > BUNDLE_MAX_SINGLE_FILE_BYTES) continue;
        if (totalBytes + byteLen > BUNDLE_MAX_BYTES) continue;
        bundledFiles.push({ path: candidate.path, content });
        totalBytes += byteLen;
      } catch {
        // Skip unreadable entries
      }
    }

    res.json({
      captureMode: job.captureMode || 'live',
      totalBytes,
      files: bundledFiles,
    });
  });

  // Restore a saved preview bundle from Firestore back into an active preview + ZIP workspace
  app.post('/api/capture/restore', requireAuth, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const ownerUid = req.authUser!.uid;
    const body = (req.body ?? {}) as {
      snapshotId?: unknown;
      url?: unknown;
      hostname?: unknown;
      siteTitle?: unknown;
      zipFilename?: unknown;
      captureMode?: unknown;
      stats?: Partial<CaptureStats>;
      options?: Partial<CaptureOptions>;
      files?: Array<{ path?: unknown; content?: unknown }>;
    };

    const rawId = typeof body.snapshotId === 'string' ? body.snapshotId.trim() : '';
    const jobId = /^[a-zA-Z0-9_-]{4,128}$/.test(rawId) ? rawId : crypto.randomUUID();

    // If workspace already exists on server for this owner, reuse it cleanly
    const existing = await loadOrGetJob(jobId);
    if (existing && existing.ownerUid === ownerUid && !existing.cleaned && existing.status === 'ready') {
      existing.expiresAt = Date.now() + JOB_TTL_MS;
      res.json({
        jobId: existing.id,
        previewToken: issueJobPreviewToken(ownerUid, existing.id),
        event: existing.lastEvent,
        siteTitle: existing.siteTitle,
        hostname: existing.hostname,
        zipFilename: existing.zipFilename,
        files: existing.files,
        diagnostics: existing.diagnostics,
        hasOriginalScreenshot: existing.hasOriginalScreenshot,
        captureMode: existing.captureMode,
      });
      return;
    }

    if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > BUNDLE_MAX_FILES) {
      res.status(400).json({ error: 'Invalid or empty preview bundle.' });
      return;
    }

    const hostname =
      typeof body.hostname === 'string' && body.hostname.trim()
        ? body.hostname.trim().slice(0, 255)
        : 'restored-site';
    const siteTitle =
      typeof body.siteTitle === 'string' && body.siteTitle.trim()
        ? body.siteTitle.trim().slice(0, 300)
        : hostname;
    const url =
      typeof body.url === 'string' && body.url.trim()
        ? body.url.trim().slice(0, 2048)
        : `https://${hostname}`;
    const zipFilename =
      typeof body.zipFilename === 'string' && body.zipFilename.trim()
        ? path.basename(body.zipFilename.trim()).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
        : `sitegrab-${hostname}.zip`;
    const captureMode =
      body.captureMode === 'clone' ||
      body.captureMode === 'zip' ||
      body.captureMode === 'screenshot'
        ? body.captureMode
        : 'live';

    const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
    const siteDir = path.join(tempRoot, 'site');
    const baseDir = path.resolve(siteDir);
    const zipPath = path.join(tempRoot, zipFilename);

    try {
      await fsp.rm(tempRoot, { recursive: true, force: true });
      await fsp.mkdir(siteDir, { recursive: true });

      let writtenBytes = 0;
      let writtenCount = 0;
      for (const item of body.files) {
        if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') continue;
        const cleanRel = item.path
          .replace(/\\/g, '/')
          .replace(/^\/+/, '')
          .split('/')
          .filter((seg) => seg && seg !== '.' && seg !== '..')
          .join('/');
        if (!cleanRel) continue;

        const ext = path.posix.extname(cleanRel).toLowerCase();
        if (!BUNDLE_EXTS.has(ext)) continue;

        const destPath = path.resolve(baseDir, cleanRel);
        if (!destPath.startsWith(baseDir + path.sep)) continue;

        const bytes = Buffer.byteLength(item.content, 'utf8');
        if (bytes > BUNDLE_MAX_SINGLE_FILE_BYTES || writtenBytes + bytes > BUNDLE_MAX_BYTES + 100_000) {
          continue;
        }
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        await fsp.writeFile(destPath, item.content, 'utf8');
        writtenBytes += bytes;
        writtenCount += 1;
      }

      if (writtenCount === 0) {
        await fsp.rm(tempRoot, { recursive: true, force: true });
        res.status(400).json({ error: 'No valid preview files found in saved history bundle.' });
        return;
      }

      const files = await listDirectoryFiles(siteDir);
      const rootFolderName = path.basename(zipFilename, '.zip') || `sitegrab-${hostname}`;
      const zipBytes = await createZipArchive(siteDir, zipPath, rootFolderName);

      const stats: CaptureStats = {
        pagesCaptured: Math.max(1, Number(body.stats?.pagesCaptured ?? 1) || 1),
        assetsCaptured: Number(body.stats?.assetsCaptured ?? Math.max(0, files.length - 1)) || 0,
        htmlCount: Number(body.stats?.htmlCount ?? 1) || 1,
        cssCount: Number(body.stats?.cssCount ?? 0) || 0,
        jsCount: Number(body.stats?.jsCount ?? 0) || 0,
        imagesCount: Number(body.stats?.imagesCount ?? 0) || 0,
        fontsCount: Number(body.stats?.fontsCount ?? 0) || 0,
        otherAssetsCount: Number(body.stats?.otherAssetsCount ?? 0) || 0,
        totalBytes: files.reduce((sum, f) => sum + f.size, 0),
        zipBytes,
        sourceMapsRecovered: Number(body.stats?.sourceMapsRecovered ?? 0) || 0,
        skippedRobots: Number(body.stats?.skippedRobots ?? 0) || 0,
        failedAssetsCount: Number(body.stats?.failedAssetsCount ?? 0) || 0,
        screenshotsCount: Number(body.stats?.screenshotsCount ?? 0) || 0,
        durationMs: Number(body.stats?.durationMs ?? 0) || 0,
      };

      const options: CaptureOptions = {
        url,
        crawlDepth: Number(body.options?.crawlDepth ?? 0) || 0,
        maxPages: Math.max(1, Number(body.options?.maxPages ?? 1) || 1),
        formatCode: body.options?.formatCode !== false,
        recoverSourceMaps: Boolean(body.options?.recoverSourceMaps),
        respectRobots: true,
        includeImages: body.options?.includeImages !== false,
        includeFonts: body.options?.includeFonts !== false,
        mobileViewport: Boolean(body.options?.mobileViewport),
        saveScreenshots: Boolean(body.options?.saveScreenshots),
        preserveInternalNav: body.options?.preserveInternalNav !== false,
      };

      const readyEvent: ProgressEvent = {
        jobId,
        stage: 'ready',
        message: 'Restored saved workspace from project history.',
        percent: 100,
        stats,
        files,
        diagnostics: {
          brokenImages: [],
          failedResources: [],
          unresolvedLinks: [],
        },
        hasOriginalScreenshot: false,
        captureMode,
      };

      const restoredJob: CaptureJob = {
        id: jobId,
        ownerUid,
        url,
        hostname,
        siteTitle,
        options,
        status: 'ready',
        lastEvent: readyEvent,
        tempRoot,
        siteDir,
        zipPath,
        zipFilename,
        originalScreenshotPath: path.join(tempRoot, '_original-preview.png'),
        hasOriginalScreenshot: false,
        captureMode,
        files,
        diagnostics: readyEvent.diagnostics!,
        createdAt: Date.now(),
        expiresAt: Date.now() + JOB_TTL_MS,
        cleaned: false,
        subscribers: new Set(),
      };

      jobs.set(jobId, restoredJob);
      await saveJobMetaToDisk(restoredJob);

      res.json({
        jobId,
        previewToken: issueJobPreviewToken(ownerUid, jobId),
        event: readyEvent,
        siteTitle,
        hostname,
        zipFilename,
        files,
        diagnostics: restoredJob.diagnostics,
        hasOriginalScreenshot: false,
        captureMode,
      });
    } catch {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      res.status(500).json({ error: 'Failed to restore saved project preview.' });
    }
  });

  app.post('/api/capture/:jobId/preview-token', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).json({ error: 'Preview workspace unavailable or expired.' });
      return;
    }
    res.json({
      previewToken: issueJobPreviewToken(req.authUser!.uid, job.id),
    });
  });

  // Serve original rendered screenshot for Original vs. Captured comparison
  app.get('/api/capture/:jobId/original-screenshot', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || !job.hasOriginalScreenshot) {
      res.status(404).send('Original screenshot unavailable.');
      return;
    }
    try {
      const buf = await fsp.readFile(job.originalScreenshotPath);
      const mime = detectImageMimeType(buf) || 'image/png';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch {
      res.status(404).send('Original screenshot not found.');
    }
  });

  // Read individual captured text file safely for inspection / AI context
  app.get('/api/capture/:jobId/file', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).json({ error: 'Workspace not found or expired.' });
      return;
    }
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!isEditableTextFile(relPath)) {
      res.status(400).json({ error: 'Only text source files (HTML, CSS, JS, JSON, MD) can be inspected.' });
      return;
    }
    try {
      const resolved = resolveSafeSiteFile(job.siteDir, relPath);
      const stat = await fsp.stat(resolved);
      if (stat.size > 512 * 1024) {
        res.status(413).json({ error: 'File is larger than 512 KB preview limit.' });
        return;
      }
      const content = await fsp.readFile(resolved, 'utf8');
      res.json({ path: relPath, size: stat.size, content });
    } catch (err) {
      if (err instanceof AiServiceError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(404).json({ error: 'File not found in captured project.' });
    }
  });

  // Optional Gemini AI Code Assistant operating on real captured files
  app.post('/api/capture/:jobId/ai', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).json({ error: 'Capture workspace expired or not ready. Please recapture the site.' });
      return;
    }

    const body = req.body as {
      prompt?: unknown;
      mode?: unknown;
      selectedFile?: unknown;
      history?: unknown;
    };

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 4000) {
      res.status(400).json({ error: 'Please enter a prompt (up to 4,000 characters).' });
      return;
    }

    const mode = body.mode === 'explain' ? 'explain' : 'modify';
    const selectedFile =
      typeof body.selectedFile === 'string' && body.selectedFile.trim()
        ? body.selectedFile.trim()
        : undefined;

    const history = Array.isArray(body.history)
      ? body.history
          .filter(
            (m): m is { role: 'user' | 'model'; text: string } =>
              Boolean(m) &&
              (m.role === 'user' || m.role === 'model') &&
              typeof m.text === 'string',
          )
          .slice(-6)
      : [];

    try {
      const result = await runAiCodeAssistant({
        job,
        prompt,
        mode,
        selectedFile,
        history,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof AiServiceError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'AI assistant request failed.' });
    }
  });

  // Apply AI-suggested file modifications to the captured project and rebuild ZIP
  app.post('/api/capture/:jobId/apply-edits', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).json({ error: 'Capture workspace expired or not ready.' });
      return;
    }

    const body = req.body as { edits?: unknown };
    if (!Array.isArray(body.edits) || body.edits.length === 0) {
      res.status(400).json({ error: 'No edits provided.' });
      return;
    }

    const appliedFiles: string[] = [];
    try {
      for (const rawEdit of body.edits as Partial<AiFileEdit>[]) {
        if (
          !rawEdit ||
          typeof rawEdit.filePath !== 'string' ||
          typeof rawEdit.updatedContent !== 'string'
        ) {
          continue;
        }
        const cleanRel = rawEdit.filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!isEditableTextFile(cleanRel)) continue;

        const dest = resolveSafeSiteFile(job.siteDir, cleanRel);
        let contentToWrite = rawEdit.updatedContent;
        const ext = path.posix.extname(cleanRel).toLowerCase();

        if (ext === '.html' || ext === '.htm') {
          if (!contentToWrite.includes('data-sitegrab-sandbox-shim')) {
            if (/<head[^>]*>/i.test(contentToWrite)) {
              contentToWrite = contentToWrite.replace(/<head[^>]*>/i, (m) => `${m}\n    ${SANDBOX_COMPAT_HEAD_SHIM}`);
            } else {
              contentToWrite = `${SANDBOX_COMPAT_HEAD_SHIM}\n${contentToWrite}`;
            }
          }
          const hasRuntimeFile = await fsp
            .stat(path.join(job.siteDir, 'js', 'sg-runtime.js'))
            .then(() => true)
            .catch(() => false);
          if (hasRuntimeFile && !contentToWrite.includes('sg-runtime.js')) {
            const relPrefix = cleanRel.startsWith('pages/') ? '../' : './';
            const runtimeTag = `\n    <script src="${relPrefix}js/sg-runtime.js"></script>`;
            if (/<\/body>/i.test(contentToWrite)) {
              contentToWrite = contentToWrite.replace(/<\/body>/i, `${runtimeTag}\n  </body>`);
            } else {
              contentToWrite += runtimeTag;
            }
          }
        }

        if (job.options.formatCode) {
          if (ext === '.html' || ext === '.htm') {
            contentToWrite = await formatCapturedCode(contentToWrite, 'html');
          } else if (ext === '.css') {
            contentToWrite = await formatCapturedCode(contentToWrite, 'css');
          } else if (ext === '.js' || ext === '.mjs') {
            contentToWrite = await formatCapturedCode(contentToWrite, 'js');
          }
        }

        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, contentToWrite, 'utf8');
        appliedFiles.push(cleanRel);
      }

      if (appliedFiles.length === 0) {
        res.status(400).json({ error: 'No valid editable files in edit list.' });
        return;
      }

      // Refresh file list & repack ZIP archive with AI changes
      job.files = await listDirectoryFiles(job.siteDir);
      const totalBytes = job.files.reduce((sum, f) => sum + f.size, 0);
      job.lastEvent.stats.totalBytes = totalBytes;

      const rootFolderName = path.basename(job.zipFilename, '.zip') || `sitegrab-${job.hostname}`;
      const zipBytes = await createZipArchive(job.siteDir, job.zipPath, rootFolderName);
      job.lastEvent.stats.zipBytes = zipBytes;
      job.lastEvent.files = job.files;
      job.expiresAt = Date.now() + JOB_TTL_MS;
      await saveJobMetaToDisk(job);

      res.json({
        appliedFiles,
        files: job.files,
        stats: job.lastEvent.stats,
      });
    } catch (err) {
      if (err instanceof AiServiceError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: 'Failed to apply edits and rebuild ZIP.' });
    }
  });

  async function servePreviewAsset(
    job: CaptureJob,
    relRequested: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    let cleanRel = relRequested.replace(/^\/+/, '') || 'index.html';
    const baseDir = path.resolve(job.siteDir);

    // Always serve the latest interactive runtime enhancer for sg-runtime.js so restored history previews also benefit
    if (cleanRel === 'js/sg-runtime.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      res.send(ENHANCED_INTERACTION_JS);
      return;
    }

    let targetPath = path.resolve(baseDir, cleanRel);

    if (targetPath !== baseDir && !targetPath.startsWith(baseDir + path.sep)) {
      res.status(403).send('Forbidden');
      return;
    }

    const resolveTargetFile = async (candidate: string): Promise<{ fullPath: string; rel: string } | null> => {
      try {
        const st = await fsp.stat(candidate);
        if (st.isDirectory()) {
          const idx = path.resolve(candidate, 'index.html');
          if (!idx.startsWith(baseDir + path.sep)) return null;
          await fsp.stat(idx);
          return { fullPath: idx, rel: path.posix.join(cleanRel, 'index.html') };
        }
        return { fullPath: candidate, rel: cleanRel };
      } catch {
        // Resolve extensionless HTML routes (e.g. /about -> about.html or pages/about.html) or SPA fallback
        if (!path.extname(cleanRel)) {
          const variants = [`${cleanRel}.html`, `pages/${cleanRel}.html`, `${cleanRel}/index.html`];
          for (const v of variants) {
            const vp = path.resolve(baseDir, v);
            if (!vp.startsWith(baseDir + path.sep)) continue;
            try {
              const vst = await fsp.stat(vp);
              if (vst.isFile()) return { fullPath: vp, rel: v };
            } catch {
              // continue
            }
          }
          const spaIdx = path.resolve(baseDir, 'index.html');
          try {
            const ist = await fsp.stat(spaIdx);
            if (ist.isFile()) return { fullPath: spaIdx, rel: 'index.html' };
          } catch {
            // no index.html
          }
        }
        return null;
      }
    };

    const resolved = await resolveTargetFile(targetPath);
    if (!resolved) {
      res.status(404).send('File not found in captured archive.');
      return;
    }

    targetPath = resolved.fullPath;
    cleanRel = resolved.rel;

    try {
      const ext = path.extname(targetPath).toLowerCase();
      res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const rawHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      const rawProto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
      const validHost = /^[a-zA-Z0-9.:-]+$/.test(rawHost) ? rawHost : '';
      const originSource = validHost ? `${rawProto}://${validHost} https://${validHost} http://${validHost}` : '';

      // Opaque sandboxed iframes (allow-scripts allow-forms) cannot match 'self'; allow explicit preview host + https assets cleanly
      res.setHeader(
        'Content-Security-Policy',
        `default-src ${originSource} 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; script-src ${originSource} 'self' https: 'unsafe-inline' 'unsafe-eval' data: blob:; style-src * 'unsafe-inline' data: blob:; img-src * data: blob:; font-src * data: blob:; media-src * data: blob:; connect-src ${originSource} 'self' https: http: data: blob:;`,
      );

      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }

      if (ext === '.html' || ext === '.htm') {
        let html = await fsp.readFile(targetPath, 'utf8');
        // Strip restrictive meta CSP from captured HTML so preview scripts/styles execute cleanly
        html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');

        // Convert stray root-relative asset/page paths (/css/..., /js/..., /assets/...) into archive-relative paths
        const depthSegments = Math.max(0, cleanRel.split('/').length - 1);
        const relRootPrefix = depthSegments === 0 ? './' : '../'.repeat(depthSegments);
        html = html.replace(
          /(\s(?:src|href|poster)=["'])\/(?!\/|api\/)([^"']+)(["'])/gi,
          `$1${relRootPrefix}$2$3`,
        );

        // Ensure latest sandbox compatibility shim runs before any page script
        if (/<script[^>]+data-sitegrab-sandbox-shim[^>]*>[\s\S]*?<\/script>/i.test(html)) {
          html = html.replace(
            /<script[^>]+data-sitegrab-sandbox-shim[^>]*>[\s\S]*?<\/script>/i,
            SANDBOX_COMPAT_HEAD_SHIM,
          );
        } else if (/<head[^>]*>/i.test(html)) {
          html = html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${SANDBOX_COMPAT_HEAD_SHIM}`);
        } else {
          html = `${SANDBOX_COMPAT_HEAD_SHIM}\n${html}`;
        }

        // Ensure interactive runtime is present even on imported ZIPs or older restored snapshots
        if (!html.includes('sg-runtime.js') && !html.includes('data-sitegrab-interactive-runtime')) {
          const safeRuntime = ENHANCED_INTERACTION_JS.replace(/<\/script>/gi, '<\\/script>');
          const tag = `\n    <script data-sitegrab-interactive-runtime>${safeRuntime}</script>`;
          if (/<\/body>/i.test(html)) {
            html = html.replace(/<\/body>/i, `${tag}\n  </body>`);
          } else {
            html += tag;
          }
        }

        res.send(html);
        return;
      }

      fs.createReadStream(targetPath).pipe(res);
    } catch {
      res.status(404).send('File not found in captured archive.');
    }
  }

  // Cookie-free signed path preview (works inside opaque sandboxed iframes & nested embeds)
  app.get('/api/capture/:jobId/p/:previewToken/*', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const token = String(req.params.previewToken || '');
    const tokenUid = verifyJobPreviewToken(token, jobId);
    if (!tokenUid) {
      res.status(401).send('Preview session expired. Click Recapture or reload preview.');
      return;
    }
    const job = await loadOrGetJob(jobId);
    if (!job || job.ownerUid !== tokenUid || job.cleaned || job.status !== 'ready') {
      res.status(404).send('Preview unavailable or archive expired.');
      return;
    }
    await servePreviewAsset(job, req.params[0] || 'index.html', req, res);
  });

  app.get('/api/capture/:jobId/p/:previewToken', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const token = String(req.params.previewToken || '');
    const tokenUid = verifyJobPreviewToken(token, jobId);
    if (!tokenUid) {
      res.status(401).send('Preview session expired. Click Recapture or reload preview.');
      return;
    }
    const job = await loadOrGetJob(jobId);
    if (!job || job.ownerUid !== tokenUid || job.cleaned || job.status !== 'ready') {
      res.status(404).send('Preview unavailable or archive expired.');
      return;
    }
    res.redirect(
      302,
      `/api/capture/${encodeURIComponent(jobId)}/p/${encodeURIComponent(token)}/index.html`,
    );
  });

  // Legacy cookie / query-token preview route
  app.get('/api/capture/:jobId/preview/*', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const sessionUid = await getPreviewSessionUid(req, jobId);
    if (!sessionUid) {
      res.status(401).send('Sign in required to preview private workspaces.');
      return;
    }
    const job = await loadOrGetJob(jobId);
    if (!job || job.ownerUid !== sessionUid || job.cleaned || job.status !== 'ready') {
      res.status(404).send('Preview unavailable or archive expired.');
      return;
    }
    await servePreviewAsset(job, req.params[0] || 'index.html', req, res);
  });

  app.get('/api/capture/:jobId/preview', async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const sessionUid = await getPreviewSessionUid(req, jobId);
    if (!sessionUid) {
      res.status(401).send('Sign in required to preview private workspaces.');
      return;
    }
    const suffix =
      typeof req.query.pt === 'string' && req.query.pt
        ? `?pt=${encodeURIComponent(req.query.pt)}`
        : '';
    res.redirect(302, `/api/capture/${encodeURIComponent(jobId)}/preview/index.html${suffix}`);
  });

  app.head('/api/capture/:jobId/download', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid || job.cleaned || job.status !== 'ready') {
      res.status(404).end();
      return;
    }
    try {
      const stat = await fsp.stat(job.zipPath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${job.zipFilename}"`);
      res.status(200).end();
    } catch {
      res.status(404).end();
    }
  });

  // Stream ZIP archive cleanly while preserving workspace for preview & AI edits during TTL
  app.get('/api/capture/:jobId/download', requireAuth, async (req: Request, res: Response) => {
    const job = await loadOrGetJob(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.status(404).json({ error: 'Archive not found or expired. Click Recapture to regenerate it.' });
      return;
    }
    if (job.cleaned) {
      res.status(410).json({ error: 'Workspace was closed and temporary files were removed.' });
      return;
    }
    if (job.status !== 'ready') {
      res.status(409).json({ error: 'Capture is not ready for download yet.' });
      return;
    }

    try {
      const stat = await fsp.stat(job.zipPath);
      if (stat.size <= 0) {
        res.status(500).json({ error: 'Generated ZIP archive is empty.' });
        return;
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${job.zipFilename}"`);
      res.setHeader('Cache-Control', 'no-store');

      const stream = fs.createReadStream(job.zipPath);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream ZIP archive.' });
        }
      });

      stream.pipe(res);
    } catch {
      res.status(404).json({ error: 'ZIP file no longer available.' });
    }
  });

  // Explicit workspace cleanup endpoint
  app.delete('/api/capture/:jobId', requireAuth, async (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const job = jobs.get(jobId);
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.json({ ok: true });
      return;
    }
    await cleanupJobFiles(job);
    jobs.delete(jobId);
    res.json({ ok: true });
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type?: string }).type === 'entity.too.large'
    ) {
      const isShot = req.path.includes('from-screenshot');
      res.status(413).json({
        errorCode: 'SIZE_LIMIT_EXCEEDED',
        error: isShot
          ? 'Uploaded screenshot exceeds the 10 MB upload limit.'
          : 'Uploaded ZIP exceeds the 50 MB upload limit.',
      });
      return;
    }
    next(err);
  });

  return app;
}
