import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Writable } from 'node:stream';
import type { CaptureStats } from './types.ts';

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

export async function writeArchiveReadme(options: {
  siteDir: string;
  targetUrl: string;
  siteTitle: string;
  stats: CaptureStats;
  formatted: boolean;
  recoveredSourceMaps: boolean;
}): Promise<void> {
  const { siteDir, targetUrl, siteTitle, stats, formatted, recoveredSourceMaps } = options;

  const readme = `# ${siteTitle || 'Captured Website'}

Captured with **SiteGrab** from \`${targetUrl}\`.

> **Ownership Notice:** Ensure you own or have explicit permission to store, modify, or redistribute the contents of this archive.

## Quick Start (Run Locally)

Open this folder in **VS Code** and launch a local static server using any of the options below:

### Option 1: Node.js (\`serve\`)
\`\`\`bash
npx serve .
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

## Archive Contents

- \`index.html\` — Entry page (rendered DOM with relative local paths)
- \`assets/css/\` — Stylesheets with rewritten local \`url(...)\` references
- \`assets/js/\` — Captured scripts
- \`assets/images/\` — Images, icons, and vector graphics
- \`assets/fonts/\` — Web fonts (\`.woff2\`, \`.woff\`, \`.ttf\`, etc.)
${recoveredSourceMaps && stats.sourceMapsRecovered > 0 ? '- `recovered-src/` — Original source files reconstructed from published `.map` source maps\n' : ''}
## Snapshot Summary

- **Pages captured:** ${stats.pagesCaptured}
- **Assets saved:** ${stats.assetsCaptured}
- **Source map files recovered:** ${stats.sourceMapsRecovered}
- **Prettier formatted:** ${formatted ? 'Yes (HTML, CSS, JS)' : 'No'}
- **Total captured size:** ${(stats.totalBytes / (1024 * 1024)).toFixed(2)} MB
`;

  await fsp.writeFile(path.join(siteDir, 'README.md'), readme, 'utf8');
}

export async function createZipArchive(sourceDir: string, zipPath: string): Promise<number> {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const { ZipArchive } = (await import('archiver')) as unknown as ArchiverV8Module;

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });

    output.on('close', () => {
      resolve(archive.pointer());
    });

    output.on('error', (err) => {
      reject(err);
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}
