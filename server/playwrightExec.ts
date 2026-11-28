import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/**
 * Resolves an installed Playwright Chromium / headless-shell binary cleanly
 * across full Chrome builds and container headless-shell installations.
 */
export function resolveChromiumExecutablePath(): string | undefined {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  try {
    const defaultExec = chromium.executablePath();
    if (defaultExec && fs.existsSync(defaultExec)) {
      return defaultExec;
    }
  } catch {
    // Fall through to well-known locations
  }

  const staticCandidates = [
    '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const candidate of staticCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Scan /ms-playwright directory if versioned directory exists
  try {
    if (fs.existsSync('/ms-playwright')) {
      const entries = fs.readdirSync('/ms-playwright');
      for (const entry of entries) {
        if (entry.startsWith('chromium-')) {
          const p = path.join('/ms-playwright', entry, 'chrome-linux64', 'chrome');
          if (fs.existsSync(p)) return p;
        }
        if (entry.startsWith('chromium_headless_shell-')) {
          const p = path.join(
            '/ms-playwright',
            entry,
            'chrome-headless-shell-linux64',
            'chrome-headless-shell',
          );
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch {
    // Ignore directory scan errors
  }

  return undefined;
}
