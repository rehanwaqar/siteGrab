import path from 'node:path';
import * as cheerio from 'cheerio';

export function normalizeUrlKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export function resolveToLocalPath(
  rawRef: string,
  baseUrl: string,
  currentLocalPath: string,
  assetPathMap: Map<string, string>,
  pagePathMap?: Map<string, string>,
): string | null {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('#')
  ) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  const hash = resolved.hash || '';
  resolved.hash = '';
  const key = resolved.toString();

  const targetAsset = assetPathMap.get(key);
  const targetPage = pagePathMap?.get(key);
  const targetRel = targetAsset ?? targetPage;

  if (!targetRel) {
    return null;
  }

  const fromDir = path.posix.dirname(currentLocalPath);
  let rel = path.posix.relative(fromDir, targetRel);
  if (!rel) {
    rel = path.posix.basename(targetRel);
  } else if (!rel.startsWith('.') && !rel.startsWith('/')) {
    rel = `./${rel}`;
  }

  return `${rel}${hash}`;
}

export function rewriteCssUrls(
  cssText: string,
  cssOriginalUrl: string,
  cssLocalRelPath: string,
  assetPathMap: Map<string, string>,
): string {
  // Rewrite url(...) declarations
  let output = cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, ref) => {
    const rewritten = resolveToLocalPath(ref, cssOriginalUrl, cssLocalRelPath, assetPathMap);
    if (!rewritten) return full;
    const q = quote || '"';
    return `url(${q}${rewritten}${q})`;
  });

  // Rewrite @import "..." or @import '...'
  output = output.replace(/@import\s+(['"])([^'"]+)\1/gi, (full, quote, ref) => {
    const rewritten = resolveToLocalPath(ref, cssOriginalUrl, cssLocalRelPath, assetPathMap);
    if (!rewritten) return full;
    return `@import ${quote}${rewritten}${quote}`;
  });

  return output;
}

function rewriteSrcset(
  srcset: string,
  baseUrl: string,
  currentLocalPath: string,
  assetPathMap: Map<string, string>,
): string {
  return srcset
    .split(',')
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const parts = trimmed.split(/\s+/);
      const urlPart = parts[0];
      const descriptor = parts.slice(1).join(' ');
      const rewritten = resolveToLocalPath(urlPart, baseUrl, currentLocalPath, assetPathMap);
      if (!rewritten) return trimmed;
      return descriptor ? `${rewritten} ${descriptor}` : rewritten;
    })
    .join(', ');
}

export function rewriteHtmlDocument(options: {
  html: string;
  pageOriginalUrl: string;
  pageLocalRelPath: string;
  assetPathMap: Map<string, string>;
  pagePathMap: Map<string, string>;
  preserveInternalNav?: boolean;
}): {
  html: string;
  unresolvedLinks: Array<{ href: string; page: string; type: 'asset' | 'navigation' }>;
} {
  const {
    html,
    pageOriginalUrl,
    pageLocalRelPath,
    assetPathMap,
    pagePathMap,
    preserveInternalNav = true,
  } = options;
  const $ = cheerio.load(html);
  const unresolvedLinks: Array<{ href: string; page: string; type: 'asset' | 'navigation' }> = [];
  const seenUnresolved = new Set<string>();

  // Respect <base href="..."> if present when resolving relative URLs, then remove it
  const baseEl = $('base[href]').first();
  let effectiveBase = pageOriginalUrl;
  if (baseEl.length > 0) {
    const baseHref = baseEl.attr('href');
    if (baseHref) {
      try {
        effectiveBase = new URL(baseHref, pageOriginalUrl).toString();
      } catch {
        effectiveBase = pageOriginalUrl;
      }
    }
    baseEl.remove();
  }

  // Remove target page's meta CSP & SRI integrity attributes so rewritten local ./css, ./js, and ./assets files load cleanly offline
  $('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]').remove();
  $('script[integrity], link[integrity]').removeAttr('integrity');
  $('img[loading="lazy"]').removeAttr('loading');

  const urlAttrs: Array<{ selector: string; attr: string; includePages?: boolean }> = [
    { selector: 'link[href]', attr: 'href' },
    { selector: 'script[src]', attr: 'src' },
    { selector: 'img[src]', attr: 'src' },
    { selector: 'img[data-src]', attr: 'data-src' },
    { selector: 'source[src]', attr: 'src' },
    { selector: 'video[src]', attr: 'src' },
    { selector: 'video[poster]', attr: 'poster' },
    { selector: 'audio[src]', attr: 'src' },
    { selector: 'use[href]', attr: 'href' },
    { selector: 'use[xlink\\:href]', attr: 'xlink:href' },
    { selector: 'a[href]', attr: 'href', includePages: true },
  ];

  for (const { selector, attr, includePages } of urlAttrs) {
    $(selector).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;
      const trimmed = val.trim();
      if (
        !trimmed ||
        trimmed.startsWith('data:') ||
        trimmed.startsWith('blob:') ||
        trimmed.startsWith('javascript:') ||
        trimmed.startsWith('mailto:') ||
        trimmed.startsWith('tel:') ||
        trimmed.startsWith('#')
      ) {
        return;
      }

      if (includePages && !preserveInternalNav) {
        return;
      }

      const rewritten = resolveToLocalPath(
        val,
        effectiveBase,
        pageLocalRelPath,
        assetPathMap,
        includePages ? pagePathMap : undefined,
      );
      if (rewritten) {
        $(el).attr(attr, rewritten);
        // Ensure lazy-loaded data-src also hydrates src for static offline viewing
        if (attr === 'data-src' && !$(el).attr('src')) {
          $(el).attr('src', rewritten);
        }
      } else if (unresolvedLinks.length < 100) {
        // Ignore non-rendered link rels like canonical/preconnect/alternate
        const tag = ('tagName' in el ? el.tagName?.toLowerCase() : '') || '';
        const rel = ($(el).attr('rel') || '').toLowerCase();
        if (
          tag === 'link' &&
          (rel.includes('canonical') ||
            rel.includes('preconnect') ||
            rel.includes('dns-prefetch') ||
            rel.includes('alternate') ||
            rel.includes('manifest'))
        ) {
          return;
        }
          const type = includePages ? 'navigation' : 'asset';
          const dedupeKey = `${type}:${trimmed}`;
          if (!seenUnresolved.has(dedupeKey)) {
            seenUnresolved.add(dedupeKey);
            unresolvedLinks.push({ href: trimmed, page: pageLocalRelPath, type });
          }
          // Prevent clicking uncaptured same-origin links from throwing raw 404 inside offline preview
          if (includePages) {
            try {
              const targetUrl = new URL(trimmed, effectiveBase);
              const baseUrlObj = new URL(effectiveBase);
              if (targetUrl.origin === baseUrlObj.origin) {
                $(el).attr('data-sitegrab-uncaptured', targetUrl.toString());
                $(el).attr('href', `#uncaptured-${encodeURIComponent(targetUrl.pathname)}`);
              }
            } catch {
              // Keep non-URL hrefs untouched
            }
          }
        }
      });
    }

  // Rewrite srcset attributes
  $('[srcset]').each((_, el) => {
    const val = $(el).attr('srcset');
    if (!val) return;
    $(el).attr('srcset', rewriteSrcset(val, effectiveBase, pageLocalRelPath, assetPathMap));
  });
  $('[data-srcset]').each((_, el) => {
    const val = $(el).attr('data-srcset');
    if (!val) return;
    const rewritten = rewriteSrcset(val, effectiveBase, pageLocalRelPath, assetPathMap);
    $(el).attr('data-srcset', rewritten);
    if (!$(el).attr('srcset')) {
      $(el).attr('srcset', rewritten);
    }
  });

  // Rewrite inline style="...url(...)..."
  $('[style]').each((_, el) => {
    const styleVal = $(el).attr('style');
    if (!styleVal || !styleVal.includes('url(')) return;
    $(el).attr(
      'style',
      rewriteCssUrls(styleVal, effectiveBase, pageLocalRelPath, assetPathMap),
    );
  });

  // Rewrite <style> blocks
  $('style').each((_, el) => {
    const css = $(el).html();
    if (!css) return;
    $(el).html(rewriteCssUrls(css, effectiveBase, pageLocalRelPath, assetPathMap));
  });

  // Preserve pre-rendered SPA DOM if client hydration fails or blanks out in offline/sandboxed mode
  const hasHydratedSpaRoot =
    $('#root, #__next, #app, #__nuxt').filter((_, el) => ($(el).text() || '').trim().length > 80)
      .length > 0;
  if (hasHydratedSpaRoot && $('script[data-sitegrab-spa-guard]').length === 0) {
    $('body').append(
      `<script data-sitegrab-spa-guard>(function(){var ids=['root','__next','app','__nuxt'];var snap={};for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);if(el&&el.innerHTML&&el.innerHTML.trim().length>120){snap[ids[i]]=el.innerHTML;}}if(Object.keys(snap).length===0)return;var restore=function(){for(var id in snap){var cur=document.getElementById(id);if(!cur)continue;var txt=(cur.innerText||'').trim();if(cur.innerHTML.trim().length<40||/^(404|application error|this page could not be found)/i.test(txt)){cur.innerHTML=snap[id];}}};setTimeout(restore,500);setTimeout(restore,1400);})();</script>`,
    );
  }

  // Graceful offline feedback for uncaptured links & forms without leaving broken 404 screens
  if ($('script[data-sitegrab-offline-ui]').length === 0) {
    $('body').append(
      `<script data-sitegrab-offline-ui>(function(){var showToast=function(msg){var id='sitegrab-offline-toast';var old=document.getElementById(id);if(old)old.remove();var el=document.createElement('div');el.id=id;el.style.cssText='position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:10px;padding:10px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 25px rgba(0,0,0,0.35);max-width:340px;';el.textContent=msg;document.body.appendChild(el);setTimeout(function(){if(el.parentNode)el.remove();},3500);};document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[data-sitegrab-uncaptured]'):null;if(!a)return;e.preventDefault();var raw=a.getAttribute('data-sitegrab-uncaptured')||'';showToast('Offline preview: external page not included in single-page capture ('+raw+'). Increase Crawl Depth to capture subpages.');});document.addEventListener('submit',function(e){var form=e.target;if(!form||form.tagName!=='FORM')return;var action=(form.getAttribute('action')||'').trim();if(action&&!action.startsWith('#')){e.preventDefault();showToast('Form submission previewed locally (no live backend in static snapshot).');}});})();</script>`,
    );
  }

  return { html: $.html(), unresolvedLinks };
}

export function rewriteJsUrls(
  jsText: string,
  jsLocalRelPath: string,
  assetPathMap: Map<string, string>,
  siteOrigin: string,
): string {
  // Replace exact absolute URLs or root-relative asset paths found inside string literals
  const fromDir = path.posix.dirname(jsLocalRelPath);
  let output = jsText;

  // Build replacements sorted longest-first to avoid partial prefix collisions
  const replacements: Array<[string, string]> = [];
  for (const [originalUrl, localRel] of assetPathMap.entries()) {
    let rel = path.posix.relative(fromDir, localRel);
    if (!rel.startsWith('.') && !rel.startsWith('/')) {
      rel = `./${rel}`;
    }
    replacements.push([originalUrl, rel]);

    try {
      const parsed = new URL(originalUrl);
      if (parsed.origin === siteOrigin && parsed.pathname.length > 1) {
        const rootRel = `${parsed.pathname}${parsed.search}`;
        replacements.push([rootRel, rel]);
      }
    } catch {
      // Ignore malformed URLs
    }
  }

  replacements.sort((a, b) => b[0].length - a[0].length);

  for (const [needle, replacement] of replacements) {
    if (needle.length < 6) continue;
    // Match quoted string literals ("..." or '...') containing the exact URL or root-relative path
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quotedRe = new RegExp(`(['"\`])${escaped}\\1`, 'g');
    output = output.replace(quotedRe, (_, quote) => `${quote}${replacement}${quote}`);
  }

  return output;
}
