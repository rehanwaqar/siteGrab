import fsp from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import { formatCapturedCode } from './formatter.ts';
import { normalizeAndRepairGeneratedFiles } from './generatedSiteRepair.ts';
import { isRetryableAiError, safeParseModelJson } from './jsonUtils.ts';
import { safeFetchWithRedirectValidation } from './ssrf.ts';
import type { CaptureJob, CaptureStats } from './types.ts';
import {
  createZipArchive,
  listDirectoryFiles,
  writeArchivePackageJson,
  writeArchiveReadme,
  writeArchiveWorkspaceConfig,
} from './zipper.ts';

export class CloneFallbackError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CloneFallbackError';
    this.code = code;
  }
}

let sharedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new CloneFallbackError(
      'AI_UNCONFIGURED',
      'Fallback website cloning requires GEMINI_API_KEY on the server.',
    );
  }
  if (!sharedClient) {
    sharedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return sharedClient;
}

function extractCssTokens(cssSources: string[]): {
  cssVars: string[];
  topColors: string[];
  fonts: string[];
} {
  const combined = cssSources.join('\n').slice(0, 140_000);
  const cssVars: string[] = [];
  const seenVars = new Set<string>();
  const varRe = /(--(?:bg|background|surface|card|primary|secondary|accent|brand|text|muted|border|link|btn|cta|color)[a-z0-9-]*)\s*:\s*([^;}{]{2,48})/gi;
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(combined)) !== null && cssVars.length < 18) {
    const entry = `${m[1].trim()}: ${m[2].trim()}`;
    if (!seenVars.has(m[1].toLowerCase())) {
      seenVars.add(m[1].toLowerCase());
      cssVars.push(entry);
    }
  }

  const colorCounts = new Map<string, number>();
  const hexRe = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  while ((m = hexRe.exec(combined)) !== null) {
    const hex = m[0].toLowerCase();
    colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
  }
  const topColors = Array.from(colorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([hex]) => hex);

  const fonts: string[] = [];
  const seenFonts = new Set<string>();
  const fontRe = /font-family\s*:\s*([^;}{]{3,90})/gi;
  while ((m = fontRe.exec(combined)) !== null && fonts.length < 6) {
    const cleanFont = m[1].replace(/['"]/g, '').trim();
    if (cleanFont && !seenFonts.has(cleanFont.toLowerCase())) {
      seenFonts.add(cleanFont.toLowerCase());
      fonts.push(cleanFont);
    }
  }

  return { cssVars, topColors, fonts };
}

export function extractHtmlSummary(rawHtml: string, externalCssSnippets: string[] = []): string {
  try {
    const $ = cheerio.load(rawHtml);
    const title = $('title').first().text().trim();
    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || '';
    const brandName =
      $('meta[property="og:site_name"]').attr('content')?.trim() ||
      $('meta[name="application-name"]').attr('content')?.trim() ||
      $('header img[alt]').first().attr('alt')?.trim() ||
      $('header .logo, header [class*="brand"], nav [class*="brand"]').first().text().replace(/\s+/g, ' ').trim() ||
      '';
    const desc =
      $('meta[name="description"]').attr('content')?.trim() ||
      $('meta[property="og:description"]').attr('content')?.trim() ||
      '';
    const themeColor = $('meta[name="theme-color"]').attr('content')?.trim() || '';

    const googleFontFamilies: string[] = [];
    $('link[href*="fonts.googleapis.com"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const matches = href.match(/family=([^&:]+)/g) || [];
      for (const fam of matches) {
        const clean = decodeURIComponent(fam.replace(/^family=/, '').replace(/\+/g, ' '));
        if (clean && !googleFontFamilies.includes(clean)) {
          googleFontFamilies.push(clean);
        }
      }
    });

    const inlineStyles = $('style')
      .map((_, el) => $(el).html() || '')
      .get();
    const { cssVars, topColors, fonts } = extractCssTokens([...inlineStyles, ...externalCssSnippets]);
    const allFonts = Array.from(new Set([...googleFontFamilies, ...fonts])).slice(0, 6);

    const navLinks = $('header a, nav a')
      .slice(0, 16)
      .map((_, el) => {
        const txt = $(el).text().trim().replace(/\s+/g, ' ');
        const href = ($(el).attr('href') || '').trim();
        if (!txt) return '';
        return href && !href.startsWith('#') ? `${txt} (${href.slice(0, 40)})` : txt;
      })
      .get()
      .filter(Boolean);

    const buttonsAndCtas = $(
      'button, a[class*="btn"], a[class*="button"], a[class*="cta"], [role="button"], input[type="submit"]',
    )
      .slice(0, 18)
      .map((_, el) => {
        const txt = ($(el).text() || $(el).attr('value') || $(el).attr('aria-label') || '')
          .trim()
          .replace(/\s+/g, ' ');
        return txt && txt.length <= 48 ? txt : '';
      })
      .get()
      .filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx);

    const sidebarLinks = $('aside a, [class*="sidebar"] a, [role="navigation"][aria-label*="side" i] a')
      .slice(0, 14)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter((val, idx, arr) => Boolean(val) && val.length <= 36 && arr.indexOf(val) === idx);

    const formInputs = $('form input, form select, input[type="search"], input[placeholder], input[aria-label*="search" i]')
      .slice(0, 14)
      .map((_, el) => {
        const tag = ('tagName' in el ? el.tagName?.toLowerCase() : '') || 'input';
        const type = $(el).attr('type') || (tag === 'select' ? 'select' : 'text');
        const label =
          $(el).attr('placeholder') ||
          $(el).attr('aria-label') ||
          $(el).attr('name') ||
          '';
        return label ? `${type}: "${label.trim().slice(0, 40)}"` : type;
      })
      .get()
      .filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx);

    const headings = $('h1, h2, h3')
      .slice(0, 22)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx);

    const cardItems = $('article, [class*="card"], [class*="video"], [class*="product"]')
      .slice(0, 12)
      .map((_, el) => {
        const titleTxt = $(el).find('h1, h2, h3, h4, [class*="title"]').first().text().trim().replace(/\s+/g, ' ');
        const metaTxt = $(el).find('.author, .channel, [class*="channel"], [class*="price"], [class*="meta"], small').first().text().trim().replace(/\s+/g, ' ');
        if (!titleTxt) return '';
        return metaTxt && metaTxt !== titleTxt ? `${titleTxt.slice(0, 72)} (${metaTxt.slice(0, 40)})` : titleTxt.slice(0, 72);
      })
      .get()
      .filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx);

    const keyCopy = $('main p, section p, article p, main li, section li')
      .slice(0, 14)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter((t) => t.length > 16)
      .map((t) => t.slice(0, 220));

    const footerLinks = $('footer a')
      .slice(0, 16)
      .map((_, el) => $(el).text().trim().replace(/\s+/g, ' '))
      .get()
      .filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx);

    return [
      brandName ? `Brand Name: ${brandName}` : '',
      title ? `Title: ${title}` : '',
      ogTitle && ogTitle !== title ? `OG Title: ${ogTitle}` : '',
      desc ? `Description: ${desc}` : '',
      themeColor ? `Theme Color: ${themeColor}` : '',
      cssVars.length > 0 ? `CSS Variables: ${cssVars.join('; ')}` : '',
      topColors.length > 0 ? `Observed Palette Hexes: ${topColors.join(', ')}` : '',
      allFonts.length > 0 ? `Typography / Fonts: ${allFonts.join(', ')}` : '',
      navLinks.length > 0 ? `Navigation Links: ${navLinks.join(' | ')}` : '',
      sidebarLinks.length > 0 ? `Sidebar Links: ${sidebarLinks.join(' | ')}` : '',
      buttonsAndCtas.length > 0 ? `Primary Buttons & CTAs: ${buttonsAndCtas.join(' | ')}` : '',
      formInputs.length > 0 ? `Interactive Forms & Inputs: ${formInputs.join(' | ')}` : '',
      headings.length > 0 ? `Section Headings: ${headings.join(' | ')}` : '',
      cardItems.length > 0 ? `Observed Card / Feed Items:\n- ${cardItems.join('\n- ')}` : '',
      keyCopy.length > 0 ? `Observed Copy & Items:\n- ${keyCopy.join('\n- ')}` : '',
      footerLinks.length > 0 ? `Footer Links: ${footerLinks.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

async function fetchLinkedCssSnippets(
  rawHtml: string,
  baseUrl: string,
  hostCache: Map<string, string[]>,
): Promise<string[]> {
  try {
    const $ = cheerio.load(rawHtml);
    const cssUrls: string[] = [];
    $('link[rel="stylesheet"][href]').each((_, el) => {
      if (cssUrls.length >= 2) return;
      const href = ($(el).attr('href') || '').trim();
      if (!href || href.includes('fonts.googleapis.com')) return;
      try {
        const resolved = new URL(href, baseUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          cssUrls.push(resolved.toString());
        }
      } catch {
        // Ignore malformed URLs
      }
    });
    if (cssUrls.length === 0) return [];
    const results = await Promise.allSettled(
      cssUrls.map(async (cssUrl) => {
        const { response } = await Promise.race([
          safeFetchWithRedirectValidation(cssUrl, {}, 3, hostCache),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500)),
        ]);
        if (!response.ok) return '';
        const text = await response.text();
        return text.slice(0, 70_000);
      }),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && Boolean(r.value))
      .map((r) => r.value);
  } catch {
    return [];
  }
}

export async function generateCloneFallbackForUrl(options: {
  targetUrl: string;
  failureReason: string;
  partialHtml?: string;
  partialScreenshot?: Buffer | null;
  partialVisualHints?: string;
  validatedHostCache?: Map<string, string[]>;
  job: CaptureJob;
  stats: CaptureStats;
}): Promise<void> {
  const {
    targetUrl,
    failureReason,
    partialHtml,
    partialScreenshot,
    partialVisualHints,
    validatedHostCache,
    job,
    stats,
  } = options;
  const startTime = Date.now();
  const ai = getGeminiClient();

  const parsedUrl = new URL(targetUrl);
  const hostCache = validatedHostCache ?? new Map<string, string[]>();
  let observedHtml = partialHtml || '';
  let externalCssSnippets: string[] = [];

  if (observedHtml) {
    externalCssSnippets = await fetchLinkedCssSnippets(observedHtml, targetUrl, hostCache);
  }
  let htmlHints = observedHtml ? extractHtmlSummary(observedHtml, externalCssSnippets) : '';

  // 1. If we don't have partial HTML yet, try a fast SSRF-validated HTTP GET to extract real page structure & copy
  if (!htmlHints) {
    try {
      const { response, finalUrl } = await Promise.race([
        safeFetchWithRedirectValidation(
          targetUrl,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          },
          4,
          hostCache,
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6500)),
      ]);
      const ct = (response.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) {
        observedHtml = await response.text();
        externalCssSnippets = await fetchLinkedCssSnippets(observedHtml, finalUrl, hostCache);
        const extracted = extractHtmlSummary(observedHtml, externalCssSnippets);
        if (extracted) {
          htmlHints = extracted;
        }
      }
    } catch {
      // Fall through to Google Search grounding
    }
  }

  if (partialVisualHints && partialVisualHints.trim()) {
    htmlHints = htmlHints
      ? `${htmlHints}\n\nRendered Browser Visual Snapshot:\n${partialVisualHints.trim()}`
      : partialVisualHints.trim();
  }

  const hasPaletteSignal = /Observed Palette Hexes|CSS Variables|Theme Color|Computed Background/i.test(
    htmlHints,
  );

  // 2. Enrich via public Google Search grounding when hints are sparse or missing palette/section depth
  if (!htmlHints || htmlHints.length < 1100 || !hasPaletteSignal) {
    try {
      const lookupRes = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: [
            `Inspect the public website ${targetUrl} (domain: ${parsedUrl.hostname}).`,
            'Summarize in concrete factual detail so a frontend clone matches the real site accurately:',
            '- Exact brand name, tagline, core product/service, and primary hero headline + CTA buttons',
            '- Exact visual theme (dark vs light background), primary/secondary/accent hex colors, card surfaces, and typography feel',
            '- Top navigation items and footer link categories',
            '- All major homepage sections (features, catalog/products, pricing tiers, metrics, FAQ/accordions, calculators, search/filter tools, forms) with realistic authentic items',
            'Be specific and factual.',
          ].join('\n'),
          config: {
            tools: [{ googleSearch: {} }],
          },
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 9_000)),
      ]);
      if (lookupRes && lookupRes.text) {
        const searchText = lookupRes.text.slice(0, 4200);
        htmlHints = htmlHints ? `${htmlHints}\n\nPublic Site Context:\n${searchText}` : searchText;
      }
    } catch {
      // Proceed cleanly using URL/domain context
    }
  }

  const systemInstruction = [
    'You are a principal frontend engineer & design systems architect building a PIXEL-FAITHFUL, VISUALLY ACCURATE, FULLY WORKING web application clone of the exact requested website.',
    'STRICT VISUAL & STRUCTURAL ACCURACY RULES:',
    '1. If a Chromium PNG screenshot is attached and/or "Rendered Browser Visual Snapshot" metrics are provided, treat them as ground truth:',
    '   - LIGHT vs. DARK POLARITY: Match the exact observed background & surface polarity! If the target site is light-themed (e.g., #ffffff / #f8f9fa background like YouTube Light, Google, Amazon, Airbnb, Stripe, GitHub Light), build a crisp LIGHT-themed UI with exact surfaces, muted borders, and dark ink text (#0f0f0f). ONLY use dark mode by default if the target site or screenshot is actually dark (#0f0f0f / #121212 / #0d1117 like Spotify, Netflix, Twitch, Discord). Always support a working Light/Dark theme toggle too.',
    '   - EXACT COLOR PALETTE & TYPOGRAPHY: Define CSS :root custom properties using the exact observed hex palette, brand accent color (e.g. YouTube #ff0000 / pill buttons #f2f2f2, Spotify #1db954, GitHub #1f883d), font family stack, spacing rhythm, and border radii.',
    '   - SPATIAL LAYOUT & CHROME: Faithfully reproduce the real page skeleton:',
    '     * Sticky header bar with authentic inline <svg> brand logo & crisp wordmark on the left (NEVER generic text placeholders), centered search pill input + search/clear/voice triggers when applicable, and right utility controls (Create/+, Notifications bell with badge, Sign In button / User Avatar).',
    '     * Left collapsible navigation sidebar / mini-rail whenever the target app uses one (with active pill highlight and section dividers for Subscriptions / Library / Playlists / Channels).',
    '     * Horizontal scrollable category filter chip bar directly above the content grid when present.',
    '     * Exact card geometry and proportions (e.g. 16:9 thumbnails with bottom-right duration badge + round channel avatar + 2-line bold title + channel/verified badge + views/time row; or 1:1 album square + play overlay; or product card grid with ratings/prices).',
    '2. NEVER default to generic dark-navy SaaS templates (#0b0f17 + #0ea5e9 cards), NEVER output "Lorem ipsum", "coming soon", "Static clone snapshot", or unrelated placeholder domains.',
    '3. ARTWORK & THUMBNAILS: Every <img> MUST reference a compact, clean local SVG file inside "assets/images/<slug>.svg" emitted in your `files` array (zero external image URLs that break offline). Keep each SVG compact (~500-950 chars) with rich gradients, clean illustrative shapes/icons, and subject-matched visual details — NEVER plain blank boxes.',
    'REAL WORKING APPLICATION ARCHITECTURE (UNIFIED SPA + ZERO DEAD BUTTONS):',
    '4. Build interactive web apps as a UNIFIED SINGLE-PAGE APPLICATION inside "index.html" + "css/styles.css" + "js/main.js" using `data-view` / `#hash` view switching so user session, playback, cart, and feed state NEVER reset across navigation.',
    '5. Implement a complete stateful client-side application engine in "js/main.js" backed by rich realistic seed data + "localStorage" persistence (sandbox runtime ensures localStorage works cleanly without throwing). Perform an exhaustive functional audit so EVERY visible button, link, chip, search input, menu, modal, and <form> genuinely executes and visibly updates the DOM:',
    '   - HEADER & AUTH: Hamburger sidebar collapse/drawer toggle, live Search input + submit button + clear button, Create/Upload/+ composer modal, Notifications bell popover with unread badge & mark-all-read, Light/Dark theme toggle, and Sign In / Account modal (with 1-click Demo Sign In + name/email form) persisted in localStorage, transforming Sign In into an interactive User Avatar + Account Dropdown + Sign Out.',
    '   - DOMAIN-SPECIFIC ENGINE (tailored to the exact target website):',
    '     * Video / Streaming platforms (e.g. YouTube, Vimeo, Twitch): Clicking ANY video card opens a full interactive Watch View/Player matching the real Watch page layout (animated HTML5 <canvas> + Web Audio visualizer player with Play/Pause, scrubbing seek bar, live timecode, Volume/Mute, Speed 1x-2x, Theater/Fullscreen mode, Up Next playlist sidebar), LIVE Subscribe/Unsubscribe button with subscriber counter, Like/Dislike counters, Save to Watch Later / Playlists, working Comment composer & replies, Upload Video modal adding new playable videos to the feed, live Search + Category chips, and working Sidebar views (Home, Shorts, Subscriptions, History, Watch Later, Liked Videos)!',
    '     * Social / Community apps (e.g. X, Instagram, Reddit): Stateful Sign In/Out, interactive Post/Thread Composer adding posts to the live feed, Like/Upvote/Repost/Bookmark toggles persisted in localStorage, Reply drawer, Follow toggles, Notifications popover, and Search/Feed tabs.',
    '     * E-Commerce Stores (e.g. Amazon, Shopify, Apple): Stateful Sign In/Out, Product Quick-View modal with variant selectors, slide-over Shopping Cart drawer with add/remove/quantity controls, promo code ("SAVE10"), Wishlist hearts, category filters, and working Checkout flow.',
    '     * Music / Audio Apps (e.g. Spotify, SoundCloud): Stateful Sign In/Out, persistent bottom Audio Player bar with animated waveform (Play/Pause, Prev/Next, Shuffle, Repeat, Seek), Queue drawer, Like Heart toggles, and Create Playlist flow.',
    '     * SaaS / Productivity / Docs / Portfolios: Stateful Sign In/Out, live CRUD item creation/editing/completion/deletion persisted in localStorage, sortable tables, billing toggles, interactive calculators/demos, and working forms/modals.',
    '6. Clean project structure:',
    '   - "index.html": complete multi-section app shell with semantic landmarks + `data-view` panels linking "./css/styles.css" and "./js/main.js"',
    '   - "css/styles.css": full modern responsive CSS3 with accurate :root theme tokens, light/dark variables, hover/focus transitions, modal/player/drawer styles, and mobile breakpoints',
    '   - "js/main.js": clean, bug-free vanilla JS wrapped in an IIFE powering ALL navigation views, auth, search/filters, modals, and persistence',
    '   - "pages/<slug>.html": optional standalone informational subpages only when genuinely separate (never split Sign In, Watch, Cart, or Dashboard tabs into dead static pages)',
    '   - "assets/images/<name>.svg": compact distinct local SVG brand assets & thumbnails referenced via "./assets/images/<name>.svg".',
  ].join('\n');

  const promptParts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (partialScreenshot && partialScreenshot.length > 0) {
    promptParts.push({
      inlineData: {
        mimeType: 'image/png',
        data: partialScreenshot.toString('base64'),
      },
    });
  }

  promptParts.push({
    text: [
      `Target Website URL: ${targetUrl}`,
      `Hostname: ${parsedUrl.hostname}`,
      htmlHints
        ? `Observed & Verified Website Visual Blueprint & Content (MATCH THIS EXACT POLARITY, COLORS, LAYOUT GRID, BRANDING, AND COPY):\n${htmlHints}`
        : `Accurately reconstruct the real visual appearance, light/dark polarity, brand wordmark, color palette, navigation chrome, domain sections, and working interactive application features for ${parsedUrl.hostname}.`,
      partialScreenshot && partialScreenshot.length > 0
        ? 'A real Chromium screenshot of the live target site is attached above. Inspect its exact layout structure, background brightness (light vs dark), header bar, sidebar/navigation, card grid geometry, typography, and colors, and replicate that visual identity faithfully.'
        : '',
      'CRITICAL: Build this as BOTH a visually accurate replica of the real site AND a real working interactive SPA inside index.html + css/styles.css + js/main.js with Sign In / Account persistence, working Search/Filters, working primary product workflows (e.g., Video Watch Player + Subscribe + Like + Comments for video apps; Cart/Checkout for stores; Feed Composer for social), local SVG artwork in assets/images/*.svg, and ZERO dead buttons.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });

  const callGenerate = async (modelName: string, useHighThinking: boolean) =>
    ai.models.generateContent({
      model: modelName,
      contents: { parts: promptParts },
      config: {
        systemInstruction,
        maxOutputTokens: 32768,
        ...(useHighThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } } : {}),
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            siteTitle: {
              type: Type.STRING,
              description: 'Exact brand/website title.',
            },
            summary: {
              type: Type.STRING,
              description: 'Brief summary of the accurate clone and its working interactive controls.',
            },
            files: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: {
                    type: Type.STRING,
                    description:
                      'Relative path: index.html, css/styles.css, js/main.js, pages/<name>.html, or assets/images/<name>.svg',
                  },
                  content: {
                    type: Type.STRING,
                    description: 'Complete working source code for this file.',
                  },
                },
                required: ['filePath', 'content'],
              },
            },
          },
          required: ['siteTitle', 'summary', 'files'],
        },
      },
    });

  type ClonePayload = {
    siteTitle?: string;
    summary?: string;
    files?: Array<{ filePath?: string; content?: string }>;
  };

  let parsed: ClonePayload | null = null;
  try {
    let response;
    try {
      response = await callGenerate('gemini-4-hydrogen', true);
      parsed = safeParseModelJson<ClonePayload>(response.text ?? '');
      if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
        throw new Error('EMPTY_OR_MALFORMED_PRIMARY');
      }
    } catch (primaryErr) {
      const msg = primaryErr instanceof Error ? primaryErr.message : '';
      if (isRetryableAiError(primaryErr) || msg === 'EMPTY_OR_MALFORMED_PRIMARY') {
        await new Promise((r) => setTimeout(r, 350));
        response = await callGenerate('gemini-3.1-flash-lite', false);
        parsed = safeParseModelJson<ClonePayload>(response.text ?? '');
      } else {
        throw primaryErr;
      }
    }
  } catch (err) {
    throw new CloneFallbackError(
      'CAPTURE_FAILED',
      err instanceof Error ? err.message : 'Unable to generate fallback website.',
    );
  }

  if (!parsed) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Website generator returned malformed JSON.');
  }

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'No files were produced by the website generator.');
  }

  const normalizedEntries = normalizeAndRepairGeneratedFiles(
    parsed.files,
    parsed.siteTitle?.trim() || parsedUrl.hostname,
  );

  // Reset siteDir cleanly before writing files
  await fsp.rm(job.siteDir, { recursive: true, force: true });
  const baseDir = path.resolve(job.siteDir);
  await fsp.mkdir(baseDir, { recursive: true });

  if (partialScreenshot && partialScreenshot.length > 0) {
    await fsp.mkdir(path.dirname(job.originalScreenshotPath), { recursive: true });
    await fsp.writeFile(job.originalScreenshotPath, partialScreenshot);
    job.hasOriginalScreenshot = true;
  }

  stats.pagesCaptured = 0;
  stats.assetsCaptured = 0;
  stats.htmlCount = 0;
  stats.cssCount = 0;
  stats.jsCount = 0;
  stats.imagesCount = 0;
  stats.fontsCount = 0;
  stats.otherAssetsCount = 0;
  stats.totalBytes = 0;

  let hasIndexHtml = false;
  let hasPackageJson = false;
  let hasReadme = false;
  let totalBytes = 0;

  for (const entry of normalizedEntries) {
    const destPath = path.resolve(baseDir, entry.cleanRel);
    if (!destPath.startsWith(baseDir + path.sep)) continue;

    let finalContent = entry.content;

    if (job.options.formatCode) {
      if (entry.ext === '.html' || entry.ext === '.htm') {
        finalContent = await formatCapturedCode(finalContent, 'html');
      } else if (entry.ext === '.css') {
        finalContent = await formatCapturedCode(finalContent, 'css');
      } else if (entry.ext === '.js' || entry.ext === '.mjs') {
        finalContent = await formatCapturedCode(finalContent, 'js');
      }
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await fsp.writeFile(destPath, finalContent, 'utf8');
    totalBytes += Buffer.byteLength(finalContent, 'utf8');

    if (entry.cleanRel === 'index.html') hasIndexHtml = true;
    if (entry.cleanRel === 'package.json') hasPackageJson = true;
    if (entry.cleanRel.toLowerCase() === 'readme.md') hasReadme = true;

    if (entry.ext === '.html' || entry.ext === '.htm') stats.htmlCount += 1;
    else if (entry.ext === '.css') stats.cssCount += 1;
    else if (entry.ext === '.js' || entry.ext === '.mjs') stats.jsCount += 1;
    else if (entry.ext === '.svg') stats.imagesCount += 1;
    else stats.otherAssetsCount += 1;
  }

  if (!hasIndexHtml) {
    throw new CloneFallbackError(
      'CAPTURE_FAILED',
      'Website generator did not produce an index.html entry page.',
    );
  }

  job.siteTitle = parsed.siteTitle?.trim() || parsedUrl.hostname;
  job.captureMode = 'clone';
  job.fallbackReason = failureReason;

  stats.pagesCaptured = Math.max(1, stats.htmlCount);
  stats.assetsCaptured =
    stats.cssCount + stats.jsCount + stats.imagesCount + stats.fontsCount + stats.otherAssetsCount;
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
      targetUrl,
      siteTitle: job.siteTitle,
      stats,
      formatted: job.options.formatCode,
      recoveredSourceMaps: false,
      hasPackageJson,
      captureMode: 'clone',
      fallbackReason: failureReason,
    });
  }

  job.diagnostics = {
    brokenImages: [],
    failedResources: [],
    unresolvedLinks: [],
  };

  job.files = await listDirectoryFiles(job.siteDir);
  stats.totalBytes = Math.max(totalBytes, job.files.reduce((sum, f) => sum + f.size, 0));

  const rootFolderName = path.basename(job.zipFilename, '.zip') || `sitegrab-${job.hostname}`;
  const zipBytes = await createZipArchive(job.siteDir, job.zipPath, rootFolderName);
  if (!zipBytes || zipBytes <= 0) {
    throw new CloneFallbackError('CAPTURE_FAILED', 'Generated clone ZIP archive was empty.');
  }
  stats.zipBytes = zipBytes;
  stats.durationMs = Math.max(1, Date.now() - startTime);
}
