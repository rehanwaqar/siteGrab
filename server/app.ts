import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { CaptureError, runCaptureJob } from './capture.ts';
import { IpRateLimiter } from './rateLimit.ts';
import { normalizeAndParseUrl, SsrfValidationError, validateExternalUrl } from './ssrf.ts';
import type { CaptureJob, CaptureOptions, CaptureStage, CaptureStats, ProgressEvent } from './types.ts';

const JOB_TTL_MS = 15 * 60 * 1000; // 15 minutes max retention if not downloaded
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
  app.use(express.json({ limit: '64kb' }));

  const jobs = new Map<string, CaptureJob>();
  const rateLimiter = new IpRateLimiter(5, 10 * 60 * 1000);

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
    for (const [id, job] of jobs.entries()) {
      if (now > job.expiresAt) {
        void cleanupJobFiles(job);
        jobs.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  sweepTimer.unref();

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'sitegrab' });
  });

  app.post('/api/capture', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const limitResult = rateLimiter.check(clientIp);
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

    const options: CaptureOptions = {
      url: parsedUrl.toString(),
      crawlDepth: Math.max(0, Math.min(3, Number(body?.crawlDepth ?? 0) || 0)),
      maxPages: Math.max(1, Math.min(25, Number(body?.maxPages ?? 5) || 5)),
      formatCode: body?.formatCode !== false,
      recoverSourceMaps: body?.recoverSourceMaps !== false,
      respectRobots: true, // Always enforce robots.txt compliance
    };

    const jobId = crypto.randomUUID();
    const safeHost = parsedUrl.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const tempRoot = path.join(os.tmpdir(), `sitegrab-${jobId}`);
    const siteDir = path.join(tempRoot, 'site');
    const zipFilename = `sitegrab-${safeHost}.zip`;
    const zipPath = path.join(tempRoot, zipFilename);

    const stats: CaptureStats = {
      pagesCaptured: 0,
      assetsCaptured: 0,
      totalBytes: 0,
      sourceMapsRecovered: 0,
      skippedRobots: 0,
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

  app.get('/api/capture/:jobId/events', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) {
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

    // Replay latest state immediately
    sendEvent(job.lastEvent);
    if (job.status === 'ready' || job.status === 'error') {
      return;
    }

    job.subscribers.add(sendEvent);
    req.on('close', () => {
      job.subscribers.delete(sendEvent);
    });
  });

  app.get('/api/capture/:jobId/status', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Capture job not found or expired.' });
      return;
    }
    res.json({
      ...job.lastEvent,
      siteTitle: job.siteTitle,
      hostname: job.hostname,
      zipFilename: job.zipFilename,
      cleaned: job.cleaned,
    });
  });

  // Sandboxed live preview of the captured site
  app.get('/api/capture/:jobId/preview/*', async (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job || job.cleaned || job.status !== 'ready') {
      res.status(404).send('Preview unavailable or archive already cleaned up.');
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
      // Prevent framed preview from executing arbitrary external network fetches
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';",
      );
      fs.createReadStream(targetPath).pipe(res);
    } catch {
      res.status(404).send('File not found in captured archive.');
    }
  });

  // Redirect bare /preview/:jobId to /preview/:jobId/ so relative URLs resolve properly
  app.get('/api/capture/:jobId/preview', (req: Request, res: Response) => {
    res.redirect(302, `/api/capture/${encodeURIComponent(String(req.params.jobId))}/preview/index.html`);
  });

  // Stream ZIP archive and delete temp files afterward
  app.get('/api/capture/:jobId/download', async (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: 'Archive not found or expired.' });
      return;
    }
    if (job.cleaned) {
      res.status(410).json({ error: 'Archive was already downloaded and temporary files were removed.' });
      return;
    }
    if (job.status !== 'ready') {
      res.status(409).json({ error: 'Capture is not ready for download yet.' });
      return;
    }

    try {
      const stat = await fsp.stat(job.zipPath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename="${job.zipFilename}"`);

      const stream = fs.createReadStream(job.zipPath);
      let cleanedUp = false;
      const cleanAfterStream = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void cleanupJobFiles(job);
      };

      res.on('finish', cleanAfterStream);
      res.on('close', cleanAfterStream);
      stream.on('error', () => {
        cleanAfterStream();
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream ZIP archive.' });
        }
      });

      stream.pipe(res);
    } catch {
      res.status(404).json({ error: 'ZIP file no longer available.' });
    }
  });

  return app;
}
