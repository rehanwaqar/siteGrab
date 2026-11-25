# SiteGrab AI Studio

Capture a deployed website you own or have permission to copy as a ready-to-run offline ZIP project you can open directly in VS Code, inspect visually, diagnose, and refine with an optional AI Code Assistant.

> **Acceptable Use:** Only use SiteGrab AI Studio on websites you own or have explicit permission to copy.

## Features

- **Headless Chromium Capture**: Opens the target URL in an isolated browser context, waits for network idle, and scrolls incrementally to trigger lazy-loaded assets, with optional mobile viewport emulation and page screenshot saving.
- **Capture Results Dashboard**: Reports real captured pages, HTML/CSS/JS file counts, images/fonts downloaded, failed resources, total project size, and capture duration.
- **Asset & Path Rewriting**: Captures HTML, CSS, JS, images, fonts, and JSON, then rewrites absolute and CDN URLs to relative local paths (`index.html`, `/assets/css`, `/assets/js`, `/assets/images`, `/assets/fonts`).
- **Source Map Recovery & Formatting**: Detects published `.map` source maps into `/recovered-src` and runs Prettier on HTML, CSS, and JS.
- **Multi-Page Crawl & Granular Options**: Configure crawl depth (0–3), max page count, image/font inclusion, internal link preservation, and screenshots.
- **Live SSE Progress & Visual Comparison Preview**: Streams real-time stage progress, lets you preview across Desktop/Tablet/Mobile viewports, compare Original vs. Captured views, inspect source files, and review broken image/resource diagnostics.
- **Optional AI Code Assistant**: Uses server-side Gemini (`GEMINI_API_KEY`) to explain or modify the actual captured HTML/CSS/JS files and rebuild the downloadable ZIP.
- **Download History**: Persists recent capture summaries locally in `localStorage` with quick Recapture and Download actions.

## Security & Limits

- Allows only `http://` and `https://` URLs.
- Resolves DNS and blocks loopback, private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.0.0/16`), and reserved IPv4/IPv6 ranges before navigation, across redirects, and on every subresource request.
- Respects `robots.txt` policies and does not bypass authentication, paywalls, or access controls.
- Per-IP rate limit of **5 captures per 10 minutes**.
- Job limits: **100 MB** max total size, **500 files** max, **60-second** timeout, isolated browser context per job, and automatic temporary workspace cleanup after TTL expiration.
- Static capture reproduces client-side HTML, CSS, JS, and media only; backend APIs, server logic, and databases cannot be duplicated.

## Project Structure

- `/server` — Express API, SSRF/DNS validator, `robots.txt` checker, Playwright capture pipeline, URL rewriter, source map extractor, Prettier formatter, and ZIP builder.
- `/client` — React + Tailwind CSS frontend components, progress view, sandboxed preview panel, history view, and terms page.
- `/server.ts` — Full-stack entry point mounting `/api/*` routes alongside Vite (development) or `/dist` (production).
- `/Dockerfile` — Container build configured with Playwright Chromium dependencies.

## Local Setup & Run

### 1. Install dependencies & Playwright Chromium

```bash
npm install
npx playwright install chromium
```

### 2. Run in development mode

```bash
npm run dev
```

Open `http://localhost:3000`.

### 3. Build & run in production mode

```bash
npm run build
NODE_ENV=production npm run start
```

## Deploying with Docker (Render, Railway, Fly.io)

### Render
1. Push this repository to GitHub.
2. Create a new **Web Service** on Render and select **Docker** as the runtime.
3. Render automatically builds using `/Dockerfile` and routes traffic to port `3000`.

### Railway
1. Create a new Railway project from your GitHub repo.
2. Railway detects `/Dockerfile`, installs Playwright Chromium, builds `/dist`, and exposes port `3000`.

### Fly.io
```bash
fly launch --no-deploy
fly secrets set NODE_ENV=production
fly deploy
```
Ensure your `fly.toml` internal port matches `3000`.
