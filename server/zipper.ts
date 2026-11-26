import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { CapturedFileEntry, CaptureStats } from './types.ts';

interface ArchiverV8Instance {
  on(event: string, listener: (err: Error) => void): this;
  pipe(destination: Writable): Writable;
  directory(dirpath: string, destpath: string | false): this;
  finalize(): Promise<void>;
  pointer(): number;
}

interface ArchiverV8Module {
  ZipArchive: new (options?: { zlib?: { level?: number } }) => ArchiverV8Instance;
}

function sortOrderWeight(relPath: string): number {
  const p = relPath.toLowerCase();
  if (p === 'index.html') return 0;
  if (p.endsWith('.html') && !p.includes('/')) return 1;
  if (p.startsWith('pages/')) return 2;
  if (p.startsWith('css/')) return 3;
  if (p.startsWith('js/')) return 4;
  if (p.startsWith('assets/images/')) return 5;
  if (p.startsWith('assets/fonts/')) return 6;
  if (p.startsWith('assets/')) return 7;
  if (p.startsWith('screenshots/')) return 8;
  if (p.startsWith('recovered-src/')) return 9;
  if (p.startsWith('.vscode/')) return 10;
  if (p === '.gitignore') return 11;
  if (p === 'package.json') return 12;
  if (p === 'readme.md') return 13;
  return 14;
}

export async function listDirectoryFiles(rootDir: string): Promise<CapturedFileEntry[]> {
  const results: CapturedFileEntry[] = [];

  async function walk(currentDir: string) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        const rel = path.relative(rootDir, fullPath).split(path.sep).join('/');
        results.push({ path: rel, size: stat.size });
      }
    }
  }

  await walk(rootDir);
  results.sort((a, b) => {
    const wA = sortOrderWeight(a.path);
    const wB = sortOrderWeight(b.path);
    if (wA !== wB) return wA - wB;
    return a.path.localeCompare(b.path);
  });
  return results;
}

export async function writeArchiveWorkspaceConfig(siteDir: string): Promise<void> {
  const vscodeDir = path.join(siteDir, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');
  const gitignorePath = path.join(siteDir, '.gitignore');

  try {
    await fsp.access(settingsPath);
  } catch {
    await fsp.mkdir(vscodeDir, { recursive: true });
    const settings = {
      'editor.formatOnSave': true,
      'editor.defaultFormatter': 'esbenp.prettier-vscode',
      'liveServer.settings.port': 5500,
      'liveServer.settings.ignoreFiles': ['.vscode/**', '**/*.scss', '**/*.map'],
    };
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  try {
    await fsp.access(gitignorePath);
  } catch {
    await fsp.writeFile(gitignorePath, 'node_modules/\n.DS_Store\ndist/\n*.log\n', 'utf8');
  }
}

export async function writeArchivePackageJson(options: {
  siteDir: string;
  hostname: string;
  siteTitle: string;
}): Promise<boolean> {
  const { siteDir, hostname, siteTitle } = options;
  const safeName = `sitegrab-${hostname.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`;

  const pkg = {
    name: safeName,
    version: '1.0.0',
    private: true,
    description: `Offline static snapshot of ${siteTitle || hostname} captured with SiteGrab.`,
    scripts: {
      dev: 'npx serve .',
      start: 'npx serve .',
    },
  };

  await fsp.writeFile(
    path.join(siteDir, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
    'utf8',
  );
  return true;
}

export async function writeArchiveReadme(options: {
  siteDir: string;
  targetUrl: string;
  siteTitle: string;
  stats: CaptureStats;
  formatted: boolean;
  recoveredSourceMaps: boolean;
  hasPackageJson: boolean;
  captureMode?: 'live' | 'clone' | 'zip' | 'screenshot';
  fallbackReason?: string;
}): Promise<void> {
  const {
    siteDir,
    targetUrl,
    siteTitle,
    stats,
    formatted,
    recoveredSourceMaps,
    hasPackageJson,
    captureMode,
    fallbackReason,
  } = options;

  const cloneNotice =
    captureMode === 'clone'
      ? `\n> **Fallback Clone Notice:** Direct browser capture could not complete (${fallbackReason || 'target host restricted or timed out'}), so SiteGrab reconstructed a clean, responsive static clone project for \`${targetUrl}\`.\n`
      : '';

  const readme = `# ${siteTitle || 'Captured Website'}

${captureMode === 'clone' ? 'Cloned & packaged' : 'Captured'} with **SiteGrab** from \`${targetUrl}\`.
${cloneNotice}
> **Ownership & Scope Notice:** Ensure you own or have explicit permission to store, modify, or redistribute the contents of this archive. Static capture reproduces client-side HTML, CSS, JavaScript, and public assets only; server-side APIs, authentication, and databases cannot be reproduced automatically.

## Clean Project Structure

\`\`\`text
.
├── index.html          # Main entry HTML page
${stats.pagesCaptured > 1 ? '├── pages/              # Additional crawled subpages\n' : ''}├── css/                # Stylesheets with local relative asset URLs
├── js/                 # Client-side JavaScript bundles
├── assets/
│   ├── images/         # Downloaded images, icons, and SVGs
│   └── fonts/          # Downloaded web fonts (.woff2, .woff, .ttf)
${stats.screenshotsCount > 0 ? '├── screenshots/        # Page screenshots saved during capture\n' : ''}${recoveredSourceMaps && stats.sourceMapsRecovered > 0 ? '├── recovered-src/      # Reconstructed source files from .map bundles\n' : ''}├── .vscode/
│   └── settings.json   # VS Code Live Server & Prettier settings
├── .gitignore
${hasPackageJson ? '├── package.json        # Local dev server scripts (npm run dev)\n' : ''}└── README.md
\`\`\`

## Quick Start (Run Locally in VS Code)

Open this folder in **VS Code** and launch a local static server using any of the options below:

### Option 1: Node.js (\`serve\`)
\`\`\`bash
${hasPackageJson ? 'npm run dev' : 'npx serve .'}
\`\`\`
Then open \`http://localhost:3000\` in your browser.

### Option 2: VS Code Live Server
1. Install the **Live Server** extension (\`ritwickdey.LiveServer\`) in VS Code.
2. Right-click \`index.html\` and choose **Open with Live Server**.

### Option 3: Python 3
\`\`\`bash
python3 -m http.server 8080
\`\`\`
Then open \`http://localhost:8080\`.

## Snapshot Summary

- **Pages captured:** ${stats.pagesCaptured}
- **HTML / CSS / JS files:** ${stats.htmlCount} / ${stats.cssCount} / ${stats.jsCount}
- **Images / Fonts downloaded:** ${stats.imagesCount} / ${stats.fontsCount}
- **Failed resources:** ${stats.failedAssetsCount}
- **Source map files recovered:** ${stats.sourceMapsRecovered}
- **Prettier formatted:** ${formatted ? 'Yes (HTML, CSS, JS)' : 'No'}
- **Capture duration:** ${(stats.durationMs / 1000).toFixed(2)}s
- **Total captured size:** ${(stats.totalBytes / (1024 * 1024)).toFixed(2)} MB
`;

  await fsp.writeFile(path.join(siteDir, 'README.md'), readme, 'utf8');
}

export async function createZipArchive(
  sourceDir: string,
  zipPath: string,
  rootFolderName?: string,
): Promise<number> {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const { ZipArchive } = (await import('archiver')) as unknown as ArchiverV8Module;

  const destInZip = rootFolderName && rootFolderName.trim() ? rootFolderName.trim() : false;

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 3 } });

    output.on('close', () => {
      resolve();
    });

    output.on('error', (err) => {
      reject(err);
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, destInZip);
    void archive.finalize();
  });

  const stat = await fsp.stat(zipPath);
  return stat.size;
}
