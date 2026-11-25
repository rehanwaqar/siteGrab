import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export class SsrfValidationError extends Error {
  public readonly code: string;
  constructor(message: string, code = 'BLOCKED_ADDRESS') {
    super(message);
    this.name = 'SsrfValidationError';
    this.code = code;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  '169.254.169.254',
  '0.0.0.0',
]);

export function isBlockedIp(rawIp: string): boolean {
  if (!rawIp) return true;

  // Strip IPv6 zone index if present (e.g., fe80::1%eth0)
  const cleaned = rawIp.split('%')[0].replace(/^\[|\]$/g, '');
  if (!ipaddr.isValid(cleaned)) {
    return true;
  }

  let addr = ipaddr.parse(cleaned);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    } else {
      const range = v6.range();
      // Only allow standard global unicast IPv6 addresses
      if (range !== 'unicast') {
        return true;
      }
      // Explicitly block 6to4 / Teredo / ULA / link-local / loopback / unspecified
      return false;
    }
  }

  const v4 = addr as ipaddr.IPv4;
  const range = v4.range();
  if (range !== 'unicast') {
    return true;
  }

  // Extra defensive checks on IPv4 octets
  const [a, b] = v4.octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT

  return false;
}

export function normalizeAndParseUrl(rawInput: string): URL {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new SsrfValidationError('Please enter a website URL.', 'INVALID_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrfValidationError(
      'Invalid URL format. Include https:// or http:// (for example, https://example.com).',
      'INVALID_URL',
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfValidationError(
      'Only http:// and https:// URLs are supported.',
      'INVALID_SCHEME',
    );
  }

  if (parsed.username || parsed.password) {
    throw new SsrfValidationError(
      'URLs with embedded credentials are not permitted.',
      'INVALID_URL',
    );
  }

  if (!parsed.hostname) {
    throw new SsrfValidationError('URL is missing a valid hostname.', 'INVALID_URL');
  }

  return parsed;
}

export async function validateExternalUrl(
  rawInput: string,
  validatedHostCache?: Map<string, string[]>,
): Promise<{ url: URL; resolvedIps: string[] }> {
  const parsed = normalizeAndParseUrl(rawInput);
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa')
  ) {
    throw new SsrfValidationError(
      `Access to internal or local host "${hostname}" is blocked.`,
      'BLOCKED_ADDRESS',
    );
  }

  // Check if hostname is already an IP literal
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(bareHost) !== 0) {
    if (isBlockedIp(bareHost)) {
      throw new SsrfValidationError(
        `Access to private, loopback, or reserved IP address "${bareHost}" is blocked.`,
        'BLOCKED_ADDRESS',
      );
    }
    return { url: parsed, resolvedIps: [bareHost] };
  }

  if (validatedHostCache?.has(hostname)) {
    return { url: parsed, resolvedIps: validatedHostCache.get(hostname)! };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfValidationError(
      `Could not resolve DNS for "${hostname}". Check the domain name and try again.`,
      'DNS_ERROR',
    );
  }

  if (!records || records.length === 0) {
    throw new SsrfValidationError(
      `No DNS records found for "${hostname}".`,
      'DNS_ERROR',
    );
  }

  const ips: string[] = [];
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new SsrfValidationError(
        `Domain "${hostname}" resolves to a private or reserved IP address and cannot be captured.`,
        'BLOCKED_ADDRESS',
      );
    }
    ips.push(record.address);
  }

  validatedHostCache?.set(hostname, ips);
  return { url: parsed, resolvedIps: ips };
}

export async function safeFetchWithRedirectValidation(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
  validatedHostCache?: Map<string, string[]>,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = rawUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    await validateExternalUrl(currentUrl, validatedHostCache);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(currentUrl, {
        ...init,
        redirect: 'manual',
        signal: init.signal ?? controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new SsrfValidationError('Redirect response missing Location header.', 'REDIRECT_ERROR');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      return { response: res, finalUrl: currentUrl };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new SsrfValidationError('Too many redirects while fetching resource.', 'REDIRECT_ERROR');
}
