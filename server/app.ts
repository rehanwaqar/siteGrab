import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { chromium } from 'playwright';
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
  issuePreviewCookie,
  requireAuth,
  verifySameOriginRequest,
} from './auth.ts';
import { CaptureError, runCaptureJob } from './capture.ts';
import {
  addFeedbackEntry,
  FeedbackValidationError,
  getFeedbackSummary,
} from './feedback.ts';
import { formatCapturedCode } from './formatter.ts';
import { IpRateLimiter } from './rateLimit.ts';
import { normalizeAndParseUrl, SsrfValidationError, validateExternalUrl } from './ssrf.ts';
import type {
  CaptureJob,
  CaptureOptions,
  CaptureStage,
  CaptureStats,
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

const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes retention for preview, AI editing, and ZIP download
const CLEANUP_INTERVAL_MS = 60 * 1000;

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
  app.use(express.json({ limit: '512kb' }));

  const jobs = new Map<string, CaptureJob>();
  const rateLimiter = new IpRateLimiter(5, 10 * 60 * 1000);
  const zipImportLimiter = new IpRateLimiter(10, 10 * 60 * 1000);
  const screenshotLimiter = new IpRateLimiter(8, 10 * 60 * 1000);
  const feedbackLimiter = new IpRateLimiter(10, 10 * 60 * 1000);

  async function cleanupJobFiles(job: CaptureJob): Promise<void> {
    if (job.cleaned) return;
    job.cleaned = true;
    try {
      await fsp.rm(job.tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
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
    let chromiumInstalled = false;
    try {
      const execPath = chromium.executablePath();
      chromiumInstalled = Boolean(execPath && fs.existsSync(execPath));
    } catch {
      chromiumInstalled = false;
    }
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
        error: `Rate limit reached (5 captures per 10 minutes). Please wait ${limitResult.retryAfterSeconds} seconds and try again.`,
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
        };
        jobs.set(jobId, job);
        res.status(201).json({
          jobId,
          url: job.url,
          hostname: job.hostname,
          siteTitle: job.siteTitle,
          zipFilename: job.zipFilename,
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
        };
        jobs.set(jobId, job);
        res.status(201).json({
          jobId,
          url: job.url,
          hostname: job.hostname,
          siteTitle: job.siteTitle,
          zipFilename: job.zipFilename,
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

  app.get('/api/capture/:jobId/events', requireAuth, (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.status(404).json({ error: 'Capture job not found or expired.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (evt: ProgressEvent) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (evt.stage === 'ready' || evt.stage === 'error') {
        res.end();
      }
    };

    sendEvent(job.lastEvent);
    if (job.status === 'ready' || job.status === 'error') {
      return;
    }

    job.subscribers.add(sendEvent);
    req.on('close', () => {
      job.subscribers.delete(sendEvent);
    });
  });

  app.get('/api/capture/:jobId/status', requireAuth, (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job || job.ownerUid !== req.authUser!.uid) {
      res.status(404).json({ error: 'Capture job not found or expired.' });
      return;
    }
    res.json({
      ...job.lastEvent,
      siteTitle: job.siteTitle,
      hostname: job.hostname,
      zipFilename: job.zipFilename,
      files: job.files,
      diagnostics: job.diagnostics,
      hasOriginalScreenshot: job.hasOriginalScreenshot,
      captureMode: job.captureMode,
      fallbackReason: job.fallbackReason,
      cleaned: job.cleaned,
    });
  });

  // Serve original rendered screenshot for Original vs. Captured comparison
  app.get('/api/capture/:jobId/original-screenshot', requireAuth, async (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
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
    const job = jobs.get(String(req.params.jobId));
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
    const job = jobs.get(String(req.params.jobId));
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
    const job = jobs.get(String(req.params.jobId));
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

        if (job.options.formatCode) {
          const ext = path.posix.extname(cleanRel).toLowerCase();
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

  // Sandboxed live preview of the captured site (owner-scoped via HttpOnly preview cookie or Bearer token)
  app.get('/api/capture/:jobId/preview/*', async (req: Request, res: Response) => {
    const sessionUid = await getPreviewSessionUid(req);
    if (!sessionUid) {
      res.status(401).send('Sign in required to preview private workspaces.');
      return;
    }
    const job = jobs.get(String(req.params.jobId));
    if (!job || job.ownerUid !== sessionUid || job.cleaned || job.status !== 'ready') {
      res.status(404).send('Preview unavailable or archive expired.');
      return;
    }

    const relRequested = req.params[0] || '';
    const cleanRel = relRequested.replace(/^\/+/, '') || 'index.html';

    const baseDir = path.resolve(job.siteDir);
    let targetPath = path.resolve(baseDir, cleanRel);

    if (targetPath !== baseDir && !targetPath.startsWith(baseDir + path.sep)) {
      res.status(403).send('Forbidden');
      return;
    }

    try {
      const stat = await fsp.stat(targetPath);
      if (stat.isDirectory()) {
        targetPath = path.resolve(targetPath, 'index.html');
        if (!targetPath.startsWith(baseDir + path.sep)) {
          res.status(403).send('Forbidden');
          return;
        }
      }

      const ext = path.extname(targetPath).toLowerCase();
      res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      const hostHeader = req.get('x-forwarded-host') || req.get('host');
      const protoHeader = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
      const originSource = hostHeader ? `${protoHeader}://${hostHeader} http://${hostHeader}` : '';
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self' ${originSource} data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none';`,
      );
      fs.createReadStream(targetPath).pipe(res);
    } catch {
      res.status(404).send('File not found in captured archive.');
    }
  });

  app.get('/api/capture/:jobId/preview', async (req: Request, res: Response) => {
    const sessionUid = await getPreviewSessionUid(req);
    if (!sessionUid) {
      res.status(401).send('Sign in required to preview private workspaces.');
      return;
    }
    res.redirect(302, `/api/capture/${encodeURIComponent(String(req.params.jobId))}/preview/index.html`);
  });

  app.head('/api/capture/:jobId/download', requireAuth, async (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
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
    const job = jobs.get(String(req.params.jobId));
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
