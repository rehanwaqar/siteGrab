import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import JSZip from 'jszip';
import { MAX_FILES, MAX_TOTAL_BYTES } from './capture.ts';
import { formatCapturedCode } from './formatter.ts';
import type { CaptureJob, CaptureStats, DiagnosticReport } from './types.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

export const MAX_UPLOAD_ZIP_BYTES = 50 * 1024 * 1024; // 50 MB compressed upload
const MAX_SINGLE_ENTRY_BYTES = 25 * 1024 * 1024; // 25 MB single file cap

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp']);
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf', '.eot']);
const HTML_EXTS = new Set(['.html', '.htm']);
const CSS_EXTS = new Set(['.css']);
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

export class ZipImportError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ZipImportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function hasValidZipSignature(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // Standard ZIP local file header (PK\x03\x04) or empty archive (PK\x05\x06)
  return (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06))
  );
}

function sanitizeZipEntryPath(rawName: string): string | null {
  if (!rawName || rawName.includes('\0')) return null;
  const normalized = rawName.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new ZipImportError(400, 'UNSAFE_ZIP_PATH', 'ZIP archive contains an unsafe absolute file path.');
  }
  const parts = normalized.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (parts.length === 0) return null;
  for (const seg of parts) {
    if (seg === '..') {
      throw new ZipImportError(400, 'UNSAFE_ZIP_PATH', 'ZIP archive contains a disallowed parent directory traversal path.');
    }
  }
  const joined = parts.join('/');
  // Ignore OS metadata & dependency/VCS folders cleanly
  if (
    parts[0] === '__MACOSX' ||
    parts[parts.length - 1] === '.DS_Store' ||
    parts[0] === '.git' ||
    parts[0] === 'node_modules' ||
    parts.includes('.git') ||
    parts.includes('node_modules')
  ) {
    return null;
  }
  return joined;
}

export async function processImportedZip(options: {
  zipBuffer: Buffer;
  originalZipName: string;
  job: CaptureJob;
  stats: CaptureStats;
}): Promise<void> {
  const { zipBuffer, originalZipName, job, stats } = options;
  const startTime = Date.now();

  if (!zipBuffer || zipBuffer.length === 0) {
    throw new ZipImportError(400, 'INVALID_ZIP', 'Uploaded ZIP file is empty.');
  }
  if (zipBuffer.length > MAX_UPLOAD_ZIP_BYTES) {
    throw new ZipImportError(
      413,
      'SIZE_LIMIT_EXCEEDED',
      'Uploaded ZIP exceeds the 50 MB upload limit.',
    );
  }
  if (!hasValidZipSignature(zipBuffer)) {
    throw new ZipImportError(
      400,
      'INVALID_ZIP',
      'Uploaded file is not a valid ZIP archive. Please upload a .zip export.',
    );
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(zipBuffer);
  } catch {
    throw new ZipImportError(
      400,
      'INVALID_ZIP',
      'Could not read the ZIP archive. The file may be corrupted or password-protected.',
    );
  }

  interface CandidateEntry {
    rawRel: string;
    zipObj: JSZip.JSZipObject;
  }

  const candidates: CandidateEntry[] = [];
  for (const [entryName, zipObj] of Object.entries(archive.files)) {
    if (zipObj.dir) continue;

    // Reject symlinks stored with Unix symlink mode (0120000)
    const unixPerms = (zipObj as unknown as { unixPermissions?: number | null }).unixPermissions;
    if (typeof unixPerms === 'number' && (unixPerms & 0o170000) === 0o120000) {
      throw new ZipImportError(
        400,
        'UNSAFE_ZIP_PATH',
        'ZIP archive contains symbolic links, which are blocked for security.',
      );
    }

    const rawHeaderName =
      (zipObj as unknown as { unsafeOriginalName?: string }).unsafeOriginalName || entryName;
    const sanitized = sanitizeZipEntryPath(rawHeaderName);
    if (!sanitized) continue;

    // Check internal header uncompressed size hint before inflating (zip-bomb guard)
    const internalData = (zipObj as unknown as { _data?: { uncompressedSize?: number } })._data;
    const declaredSize = internalData?.uncompressedSize;
    if (typeof declaredSize === 'number' && declaredSize > MAX_SINGLE_ENTRY_BYTES) {
      throw new ZipImportError(
        413,
        'SIZE_LIMIT_EXCEEDED',
        `File "${sanitized}" exceeds the 25 MB per-file limit.`,
      );
    }

    candidates.push({ rawRel: sanitized, zipObj });
  }

  if (candidates.length === 0) {
    throw new ZipImportError(
      400,
      'INVALID_ZIP',
      'The ZIP archive contains no extractable project files.',
    );
  }

  // Unwrap a single shared root folder if every entry sits inside it (common in Bolt/Lovable/GitHub ZIPs)
  const topSegments = new Set(candidates.map((c) => c.rawRel.split('/')[0]));
  const allHaveNested = candidates.every((c) => c.rawRel.includes('/'));
  const stripPrefix = topSegments.size === 1 && allHaveNested ? `${Array.from(topSegments)[0]}/` : '';

  const baseDir = path.resolve(job.siteDir);
  await fsp.mkdir(baseDir, { recursive: true });

  let totalBytes = 0;
  let totalFiles = 0;
  let hasIndexHtml = false;
  let hasPackageJson = false;
  let hasReadme = false;
  const htmlFilesForDiagnostics: Array<{ relPath: string; html: string }> = [];
  const extractedPathSet = new Set<string>();

  for (const item of candidates) {
    const relPath = stripPrefix ? item.rawRel.slice(stripPrefix.length) : item.rawRel;
    if (!relPath) continue;

    const ext = path.posix.extname(relPath).toLowerCase();
    if (!job.options.includeImages && IMAGE_EXTS.has(ext)) {
      continue;
    }
    if (!job.options.includeFonts && FONT_EXTS.has(ext)) {
      continue;
    }

    if (totalFiles + 1 > MAX_FILES) {
      throw new ZipImportError(
        413,
        'FILE_LIMIT_EXCEEDED',
        `Extracted archive exceeds the ${MAX_FILES} file limit.`,
      );
    }

    const buf = await item.zipObj.async('nodebuffer');
    if (buf.length > MAX_SINGLE_ENTRY_BYTES) {
      throw new ZipImportError(
        413,
        'SIZE_LIMIT_EXCEEDED',
        `Extracted file "${relPath}" exceeds the 25 MB single-file limit.`,
      );
    }
    if (totalBytes + buf.length > MAX_TOTAL_BYTES) {
      throw new ZipImportError(
        413,
        'SIZE_LIMIT_EXCEEDED',
        'Extracted archive exceeds the 100 MB total project size limit.',
      );
    }

    const destPath = path.resolve(baseDir, relPath);
    if (!destPath.startsWith(baseDir + path.sep)) {
      throw new ZipImportError(400, 'UNSAFE_ZIP_PATH', 'Resolved file path escapes workspace.');
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });

    let writtenBytes = buf.length;
    if (job.options.formatCode && (ext === '.html' || ext === '.htm' || ext === '.css' || ext === '.js' || ext === '.mjs')) {
      const parser = ext === '.css' ? 'css' : ext === '.js' || ext === '.mjs' ? 'js' : 'html';
      const formatted = await formatCapturedCode(buf.toString('utf8'), parser);
      writtenBytes = Buffer.byteLength(formatted, 'utf8');
      await fsp.writeFile(destPath, formatted, 'utf8');
      if (HTML_EXTS.has(ext)) {
        htmlFilesForDiagnostics.push({ relPath, html: formatted });
      }
    } else {
      await fsp.writeFile(destPath, buf);
      if (HTML_EXTS.has(ext)) {
        htmlFilesForDiagnostics.push({ relPath, html: buf.toString('utf8') });
      }
    }

    totalFiles += 1;
    totalBytes += writtenBytes;
    extractedPathSet.add(relPath);

    if (relPath === 'index.html') hasIndexHtml = true;
    if (relPath === 'package.json') hasPackageJson = true;
    if (relPath.toLowerCase() === 'readme.md') hasReadme = true;

    if (HTML_EXTS.has(ext)) stats.htmlCount += 1;
    else if (CSS_EXTS.has(ext)) stats.cssCount += 1;
    else if (JS_EXTS.has(ext)) stats.jsCount += 1;
    else if (IMAGE_EXTS.has(ext)) stats.imagesCount += 1;
    else if (FONT_EXTS.has(ext)) stats.fontsCount += 1;
    else stats.otherAssetsCount += 1;
  }

  if (totalFiles === 0) {
    throw new ZipImportError(
      400,
      'INVALID_ZIP',
      'No eligible project files remained after applying filter rules.',
    );
  }

  stats.pagesCaptured = Math.max(stats.htmlCount, hasIndexHtml ? 1 : 0);
  stats.assetsCaptured =
    stats.cssCount + stats.jsCount + stats.imagesCount + stats.fontsCount + stats.otherAssetsCount;
  stats.totalBytes = totalBytes;

  // Derive siteTitle from index.html <title> if present
  const rootHtml = htmlFilesForDiagnostics.find((h) => h.relPath === 'index.html') ?? htmlFilesForDiagnostics[0];
  if (rootHtml) {
    const $ = cheerio.load(rootHtml.html);
    const titleText = $('title').first().text().trim();
    if (titleText) {
      job.siteTitle = titleText;
    }
  }

  // Inspect HTML asset references for broken local links
  const unresolvedLinks: DiagnosticReport['unresolvedLinks'] = [];
  const seenUnresolved = new Set<string>();
  for (const hFile of htmlFilesForDiagnostics) {
    const $ = cheerio.load(hFile.html);
    const pageDir = path.posix.dirname(hFile.relPath);
    $('[src], link[href]').each((_, el) => {
      if (unresolvedLinks.length >= 100) return;
      const rawRef = ($(el).attr('src') || $(el).attr('href') || '').trim();
      if (
        !rawRef ||
        rawRef.startsWith('http://') ||
        rawRef.startsWith('https://') ||
        rawRef.startsWith('//') ||
        rawRef.startsWith('data:') ||
        rawRef.startsWith('blob:') ||
        rawRef.startsWith('#')
      ) {
        return;
      }
      const cleanRef = rawRef.split('?')[0].split('#')[0];
      if (!cleanRef) return;
      const candidateRel = cleanRef.startsWith('/')
        ? cleanRef.replace(/^\/+/, '')
        : path.posix.normalize(pageDir === '.' ? cleanRef : `${pageDir}/${cleanRef}`);
      if (!extractedPathSet.has(candidateRel) && !seenUnresolved.has(rawRef)) {
        seenUnresolved.add(rawRef);
        unresolvedLinks.push({ href: rawRef, page: hFile.relPath, type: 'asset' });
      }
    });
  }

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
      targetUrl: `Imported ZIP (${originalZipName})`,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: false,
      hasPackageJson,
      captureMode: 'zip',
    });
  }

  job.captureMode = 'zip';
  job.diagnostics = {
    brokenImages: [],
    failedResources: [],
    unresolvedLinks,
  };
  job.files = await listDirectoryFiles(job.siteDir);
  stats.totalBytes = job.files.reduce((sum, f) => sum + f.size, 0);

  const rootFolderName = path.basename(job.zipFilename, '.zip') || `sitegrab-${job.hostname}`;
  const zipBytes = await createZipArchive(job.siteDir, job.zipPath, rootFolderName);
  if (!zipBytes || zipBytes <= 0) {
    throw new ZipImportError(500, 'CAPTURE_FAILED', 'Generated project ZIP archive was empty.');
  }
  stats.zipBytes = zipBytes;
  stats.durationMs = Math.max(1, Date.now() - startTime);
}
