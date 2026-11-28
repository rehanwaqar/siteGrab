import { getAuthHeaders } from '../firebase';

export async function readJsonSafe<T = Record<string, unknown>>(res: Response): Promise<T | null> {
  try {
    const text = await res.text();
    if (!text || !text.trim()) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function extractHttpErrorMessage(
  res: Response,
  parsed: { error?: unknown; message?: unknown } | null,
  fallback: string,
): string {
  if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
    return parsed.error.trim();
  }
  if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }
  if (res.status === 401) {
    return 'Your session expired. Please refresh or sign in again.';
  }
  if (res.status === 413) {
    return 'Uploaded file exceeds the maximum allowed size limit.';
  }
  if (res.status === 429) {
    return 'Rate limit reached. Please wait a few moments and try again.';
  }
  if (res.status >= 502 && res.status <= 504) {
    return `Server connection was interrupted (HTTP ${res.status}). Please try again.`;
  }
  return `${fallback} (HTTP ${res.status})`;
}

export async function fetchWithResilience(
  input: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    cache?: RequestCache;
    signal?: AbortSignal;
    retries?: number;
    useAuth?: boolean;
  } = {},
): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    body,
    cache,
    signal,
    retries = 1,
    useAuth = false,
  } = options;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const authHeaders = useAuth ? await getAuthHeaders(attempt > 0) : {};
    try {
      const res = await fetch(input, {
        method,
        headers: {
          ...headers,
          ...authHeaders,
        },
        body,
        cache,
        signal,
      });

      // Retry once on 401 with force-refreshed Firebase token if using auth
      if (res.status === 401 && useAuth && attempt < retries) {
        continue;
      }

      // Retry transient 502/503/504 gateway errors for idempotent reads or start requests
      if (
        (res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt < retries
      ) {
        await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
        continue;
      }

      return res;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
        continue;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Network connection interrupted.');
}
