import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthenticatedUser;
    }
  }
}

const PREVIEW_COOKIE_NAME = 'sitegrab_preview';
const PREVIEW_TTL_MS = 30 * 60 * 1000;

// In-memory CSPRNG fallback when SESSION_SECRET env var is unset
const EPHEMERAL_SESSION_KEY = crypto.randomBytes(32);

function getSigningKey(): Buffer {
  const envSecret = process.env.SESSION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  return EPHEMERAL_SESSION_KEY;
}

let adminApp: App | null = null;

function getFirebaseAdminApp(): App {
  if (adminApp) return adminApp;

  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  let projectId = '';
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: string };
    projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : '';
  } catch {
    projectId = '';
  }

  if (!projectId || projectId === 'remixed-project-id') {
    throw new Error('Firebase is not configured with a valid projectId.');
  }

  adminApp = getApps().length > 0 ? getApp() : initializeApp({ projectId });
  return adminApp;
}

export async function verifyBearerUser(req: Request): Promise<AuthenticatedUser | null> {
  const authHeader = req.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  try {
    const app = getFirebaseAdminApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);
    if (!decoded.uid) return null;
    return {
      uid: decoded.uid,
      email: typeof decoded.email === 'string' ? decoded.email : undefined,
      emailVerified: decoded.email_verified === true,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
      picture: typeof decoded.picture === 'string' ? decoded.picture : undefined,
    };
  } catch {
    return null;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await verifyBearerUser(req);
  if (!user) {
    res.status(401).json({
      errorCode: 'UNAUTHORIZED',
      error: 'Authentication required. Please sign in to access your private workspace.',
    });
    return;
  }
  if (!user.emailVerified) {
    res.status(403).json({
      errorCode: 'EMAIL_UNVERIFIED',
      error: 'Please verify your email address before capturing or viewing workspaces.',
    });
    return;
  }
  req.authUser = user;
  next();
}

function signPreviewPayload(uid: string, expMs: number): string {
  const payloadB64 = Buffer.from(JSON.stringify({ uid, exp: expMs }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningKey()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyPreviewToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSigningKey())
    .update(payloadB64)
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      uid?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed.uid;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

function isHttpsRequest(req: Request): boolean {
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwardedProto === 'https';
}

export function verifySameOriginRequest(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // Non-CORS same-origin or server-to-server call with Bearer auth
  const expectedHost = (req.get('x-forwarded-host') || req.get('host') || '').toLowerCase();
  if (!expectedHost) return false;
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

export function issuePreviewCookie(res: Response, req: Request, uid: string): void {
  const exp = Date.now() + PREVIEW_TTL_MS;
  const value = encodeURIComponent(signPreviewPayload(uid, exp));
  const secure = isHttpsRequest(req);
  const attrs = [
    `${PREVIEW_COOKIE_NAME}=${value}`,
    'Path=/api/capture',
    `Max-Age=${Math.floor(PREVIEW_TTL_MS / 1000)}`,
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) {
    attrs.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearPreviewCookie(res: Response, req: Request): void {
  const secure = isHttpsRequest(req);
  const attrs = [
    `${PREVIEW_COOKIE_NAME}=`,
    'Path=/api/capture',
    'Max-Age=0',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
  ];
  if (secure) {
    attrs.push('Secure', 'Partitioned');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function issueJobPreviewToken(uid: string, jobId: string): string {
  const exp = Date.now() + PREVIEW_TTL_MS;
  const payloadB64 = Buffer.from(JSON.stringify({ uid, jobId, exp }), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningKey()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyJobPreviewToken(token: string, expectedJobId: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const expectedSig = crypto
    .createHmac('sha256', getSigningKey())
    .update(payloadB64)
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      uid?: unknown;
      jobId?: unknown;
      exp?: unknown;
    };
    if (
      typeof parsed.uid !== 'string' ||
      !parsed.uid ||
      typeof parsed.jobId !== 'string' ||
      parsed.jobId !== expectedJobId ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return parsed.uid;
  } catch {
    return null;
  }
}

export async function getPreviewSessionUid(req: Request, expectedJobId?: string): Promise<string | null> {
  const bearerUser = await verifyBearerUser(req);
  if (bearerUser && bearerUser.emailVerified) {
    return bearerUser.uid;
  }
  if (expectedJobId && typeof req.query.pt === 'string' && req.query.pt) {
    const tokenUid = verifyJobPreviewToken(req.query.pt, expectedJobId);
    if (tokenUid) return tokenUid;
  }
  const cookies = parseCookies(req.get('cookie'));
  const raw = cookies[PREVIEW_COOKIE_NAME];
  if (!raw) return null;
  return verifyPreviewToken(raw);
}
