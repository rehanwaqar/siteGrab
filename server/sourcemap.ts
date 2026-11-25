import fs from 'node:fs/promises';
import path from 'node:path';
import { safeFetchWithRedirectValidation } from './ssrf.ts';
import type { CapturedAsset } from './types.ts';

interface SourceMapV3 {
  version: number;
  sources?: string[];
  sourcesContent?: Array<string | null>;
  sourceRoot?: string;
}

const SOURCE_MAP_COMMENT_RE = /(?:\/\/[@#]\s*sourceMappingURL=([^\s]+)|\/\*#\s*sourceMappingURL=([^\s*]+)\s*\*\/)\s*$/m;

export function extractSourceMapUrl(code: string, assetOriginalUrl: string): string | null {
  // Check the last 1024 chars first for performance
  const tail = code.length > 2048 ? code.slice(-2048) : code;
  const match = tail.match(SOURCE_MAP_COMMENT_RE);
  const rawMapRef = (match?.[1] || match?.[2] || '').trim();
  if (!rawMapRef) return null;

  if (rawMapRef.startsWith('data:')) {
    return rawMapRef;
  }

  try {
    return new URL(rawMapRef, assetOriginalUrl).toString();
  } catch {
    return null;
  }
}

function sanitizeSourcePath(rawSource: string, sourceRoot = ''): string | null {
  let combined = sourceRoot ? `${sourceRoot.replace(/\/+$/, '')}/${rawSource}` : rawSource;

  // Strip common bundler schemes
  combined = combined
    .replace(/^webpack:\/\/[^/]*\//i, '')
    .replace(/^webpack:\/\//i, '')
    .replace(/^vite:\/\//i, '')
    .replace(/^file:\/\//i, '')
    .replace(/^https?:\/\/[^/]+\//i, '');

  // Strip query parameters or hash fragments appended by bundlers (e.g., App.vue?vue&type=script)
  const queryIdx = combined.indexOf('?');
  if (queryIdx !== -1) {
    combined = combined.slice(0, queryIdx);
  }
  const hashIdx = combined.indexOf('#');
  if (hashIdx !== -1) {
    combined = combined.slice(0, hashIdx);
  }

  // Normalize slashes and drop leading ../ or ./
  const segments = combined
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..');

  if (segments.length === 0) return null;

  // Filter out virtual webpack/vite runtime stubs that are unreadable
  const joined = segments.join('/');
  if (joined.startsWith('webpack/') && joined.includes('bootstrap')) {
    return null;
  }

  // Ensure safe filenames
  const cleanSegments = segments.map((seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_'));
  return cleanSegments.join('/');
}

function parseDataUrlSourceMap(dataUrl: string): SourceMapV3 | null {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const meta = dataUrl.slice(0, commaIdx).toLowerCase();
    const payload = dataUrl.slice(commaIdx + 1);
    const jsonStr = meta.includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
    return JSON.parse(jsonStr) as SourceMapV3;
  } catch {
    return null;
  }
}

export async function recoverSourceMaps(options: {
  assets: CapturedAsset[];
  siteDir: string;
  remainingBytes: () => number;
  remainingFiles: () => number;
  consumeBudget: (bytes: number, files: number) => boolean;
  validatedHostCache: Map<string, string[]>;
  signal?: AbortSignal;
}): Promise<number> {
  const { assets, siteDir, remainingBytes, remainingFiles, consumeBudget, validatedHostCache, signal } = options;

  const recoveredRoot = path.resolve(siteDir, 'recovered-src');
  let recoveredCount = 0;
  const seenMapUrls = new Set<string>();
  const writtenPaths = new Set<string>();

  for (const asset of assets) {
    if (signal?.aborted) break;
    if (asset.category !== 'js' && asset.category !== 'css') continue;
    if (remainingFiles() <= 0 || remainingBytes() <= 0) break;

    const text = asset.buffer.toString('utf8');
    const mapUrl = extractSourceMapUrl(text, asset.originalUrl);
    if (!mapUrl) continue;

    if (!mapUrl.startsWith('data:') && seenMapUrls.has(mapUrl)) {
      continue;
    }
    if (!mapUrl.startsWith('data:')) {
      seenMapUrls.add(mapUrl);
    }

    let parsedMap: SourceMapV3 | null = null;
    if (mapUrl.startsWith('data:')) {
      parsedMap = parseDataUrlSourceMap(mapUrl);
    } else {
      try {
        const { response } = await safeFetchWithRedirectValidation(
          mapUrl,
          { signal },
          3,
          validatedHostCache,
        );
        if (!response.ok) continue;
        const mapText = await response.text();
        if (Buffer.byteLength(mapText, 'utf8') > Math.min(remainingBytes(), 20 * 1024 * 1024)) {
          continue;
        }
        parsedMap = JSON.parse(mapText) as SourceMapV3;
      } catch {
        continue;
      }
    }

    if (!parsedMap || parsedMap.version !== 3 || !Array.isArray(parsedMap.sources) || !Array.isArray(parsedMap.sourcesContent)) {
      continue;
    }

    for (let i = 0; i < parsedMap.sources.length; i++) {
      const sourcePath = parsedMap.sources[i];
      const sourceContent = parsedMap.sourcesContent[i];
      if (!sourcePath || typeof sourceContent !== 'string') continue;

      const rel = sanitizeSourcePath(sourcePath, parsedMap.sourceRoot ?? '');
      if (!rel) continue;

      const destPath = path.resolve(recoveredRoot, rel);
      // Strict confinement inside recoveredRoot
      if (!destPath.startsWith(recoveredRoot + path.sep)) {
        continue;
      }

      if (writtenPaths.has(destPath)) continue;

      const byteLen = Buffer.byteLength(sourceContent, 'utf8');
      if (!consumeBudget(byteLen, 1)) {
        return recoveredCount;
      }

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, sourceContent, 'utf8');
      writtenPaths.add(destPath);
      recoveredCount++;
    }
  }

  return recoveredCount;
}
