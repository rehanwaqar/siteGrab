import path from 'node:path';
import * as cheerio from 'cheerio';

export interface GeneratedFileEntry {
  cleanRel: string;
  ext: string;
  content: string;
}

/**
 * Head shim ensuring localStorage, sessionStorage, document.cookie, history.pushState,
 * and window.alert operate without throwing SecurityError inside <iframe sandbox="allow-scripts allow-forms">
 * and persist user sessions/state across page navigation via window.name.
 */
export const SANDBOX_COMPAT_HEAD_SHIM = `<script data-sitegrab-sandbox-shim>(function(){try{var k='__sg_chk__';window.localStorage.setItem(k,'1');window.localStorage.removeItem(k);}catch(e){var PREFIX='__SG_STORE__:';var state={l:{},s:{},c:{}};try{if(typeof window.name==='string'&&window.name.indexOf(PREFIX)===0){var p=JSON.parse(window.name.slice(PREFIX.length));if(p&&typeof p==='object'){if(p.l&&typeof p.l==='object')state.l=p.l;if(p.s&&typeof p.s==='object')state.s=p.s;if(p.c&&typeof p.c==='object')state.c=p.c;}}}catch(err){}var save=function(){try{window.name=PREFIX+JSON.stringify(state);}catch(err){}};var mk=function(bag){return{get length(){return Object.keys(bag).length;},key:function(i){var keys=Object.keys(bag);return i>=0&&i<keys.length?keys[i]:null;},getItem:function(key){var s=String(key);return Object.prototype.hasOwnProperty.call(bag,s)?bag[s]:null;},setItem:function(key,val){bag[String(key)]=String(val);save();},removeItem:function(key){delete bag[String(key)];save();},clear:function(){for(var p in bag){if(Object.prototype.hasOwnProperty.call(bag,p))delete bag[p];}save();}};};try{Object.defineProperty(window,'localStorage',{configurable:true,value:mk(state.l)});}catch(err){}try{Object.defineProperty(window,'sessionStorage',{configurable:true,value:mk(state.s)});}catch(err){}try{var _=document.cookie;}catch(err){try{Object.defineProperty(document,'cookie',{configurable:true,get:function(){return Object.keys(state.c).map(function(n){return n+'='+state.c[n];}).join('; ');},set:function(v){var part=String(v).split(';')[0];var eq=part.indexOf('=');if(eq>0){state.c[part.slice(0,eq).trim()]=part.slice(eq+1).trim();save();}}});}catch(err2){}}}if(window.origin==='null'){window.__sgPendingToasts=window.__sgPendingToasts||[];var notify=function(msg){var text=String(msg||'Action completed');if(typeof window.__sgToast==='function'){window.__sgToast(text);}else{window.__sgPendingToasts.push(text);}};window.alert=function(msg){notify(msg||'Done');};window.confirm=function(msg){if(msg)notify(msg);return true;};window.prompt=function(msg,def){if(msg)notify(msg);return def!==undefined?String(def):'Demo Input';};window.open=function(u){if(typeof u==='string'&&u&&!/^(https?:)?\\/\\//i.test(u)){try{window.location.href=u;}catch(e){}}else if(u){notify('External link blocked in sandbox preview: '+String(u).slice(0,64));}return null;};}try{if(window.history){var origPush=window.history.pushState;var origReplace=window.history.replaceState;window.history.pushState=function(){try{return origPush.apply(window.history,arguments);}catch(err){}};window.history.replaceState=function(){try{return origReplace.apply(window.history,arguments);}catch(err){}};}}catch(err){}})();</script>`;

const ALLOWED_EXTS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.md']);

export function cleanRelInput(rawPath: string): string | null {
  const cleaned = rawPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  return cleaned || null;
}

export function normalizeGeneratedFilePath(rawPath: string): string | null {
  const cleaned = cleanRelInput(rawPath);
  if (!cleaned) return null;

  const ext = path.posix.extname(cleaned).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) return null;

  const base = path.posix.basename(cleaned);
  if ((ext === '.html' || ext === '.htm') && cleaned !== 'index.html' && !cleaned.startsWith('pages/')) {
    return `pages/${base}`;
  }
  if (ext === '.css' && !cleaned.startsWith('css/')) {
    return `css/${base}`;
  }
  if ((ext === '.js' || ext === '.mjs') && !cleaned.startsWith('js/')) {
    return `js/${base}`;
  }
  if (ext === '.svg' && !cleaned.startsWith('assets/images/')) {
    return `assets/images/${base}`;
  }
  return cleaned;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugifyName(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function buildFallbackSvgGraphic(label: string, index: number): string {
  const palettes = [
    ['#1e1b4b', '#312e81', '#e11d48', '#fb7185'],
    ['#042f2e', '#115e59', '#0d9488', '#2dd4bf'],
    ['#172554', '#1e3a8a', '#2563eb', '#60a5fa'],
    ['#27173a', '#4c1d95', '#7c3aed', '#c084fc'],
    ['#2a1810', '#7c2d12', '#ea580c', '#fb923c'],
    ['#0f172a', '#1e293b', '#059669', '#34d399'],
  ];
  const [bg1, bg2, c1, c2] = palettes[index % palettes.length];
  const cleanLabel = escapeXml((label || 'Featured Visual').trim().slice(0, 38));
  const gradId = `sgBg${index}`;
  const accentId = `sgAc${index}`;
  const variant = index % 3;
  const motif =
    variant === 0
      ? `<path d="M0 265 Q160 205 320 250 T640 220 L640 360 L0 360 Z" fill="url(#${accentId})" opacity="0.34"/>
         <circle cx="490" cy="112" r="56" fill="url(#${accentId})" opacity="0.55"/>
         <circle cx="490" cy="112" r="96" fill="${c2}" opacity="0.14"/>`
      : variant === 1
        ? `<polygon points="0,360 190,190 360,295 510,150 640,260 640,360" fill="url(#${accentId})" opacity="0.32"/>
           <circle cx="150" cy="96" r="46" fill="${c2}" opacity="0.45"/>
           <rect x="420" y="72" width="144" height="86" rx="14" fill="rgba(255,255,255,0.09)" stroke="rgba(255,255,255,0.18)"/>`
        : `<circle cx="320" cy="164" r="118" fill="url(#${accentId})" opacity="0.24"/>
           <circle cx="320" cy="164" r="70" fill="url(#${accentId})" opacity="0.38"/>
           <path d="M0 290 C180 230 440 320 640 250 L640 360 L0 360 Z" fill="rgba(0,0,0,0.28)"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360" role="img" aria-label="${cleanLabel}">
  <defs>
    <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg1}"/>
      <stop offset="100%" stop-color="${bg2}"/>
    </linearGradient>
    <linearGradient id="${accentId}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" fill="url(#${gradId})"/>
  ${motif}
  <rect x="0" y="250" width="640" height="110" fill="rgba(2,6,23,0.45)"/>
  <rect x="28" y="276" width="54" height="5" rx="2.5" fill="url(#${accentId})"/>
  <text x="28" y="314" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="700">${cleanLabel}</text>
</svg>`;
}

const DEFAULT_FALLBACK_CSS = `/* Base layout & visual tokens generated by SiteGrab */
:root {
  --bg: #0b0f17;
  --surface: #111827;
  --border: rgba(255, 255, 255, 0.12);
  --text: #f8fafc;
  --muted: #94a3b8;
  --accent: #0ea5e9;
}
*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}
img { max-width: 100%; height: auto; display: block; }
a { color: inherit; }
.sg-container { max-width: 1120px; margin: 0 auto; padding: 2rem 1.25rem; }
.sg-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 1.5rem;
}
.sg-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--accent);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 0.65rem 1.15rem;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
`;

export const ENHANCED_INTERACTION_JS = `/* SiteGrab interactive runtime enhancements */
(function () {
  if (window.__sitegrabInteractiveInit) return;
  window.__sitegrabInteractiveInit = true;

  var styleEl = document.getElementById('sg-runtime-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'sg-runtime-styles';
    styleEl.textContent = [
      '.sg-runtime-hidden{display:none!important;}',
      '.sg-nav-open{display:flex!important;flex-direction:column!important;}',
      '.sg-toast{position:fixed;bottom:18px;right:18px;z-index:2147483646;padding:10px 15px;border-radius:10px;font:500 13px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,0.28);max-width:340px;transition:opacity 0.2s ease,transform 0.2s ease;}',
      '.sg-modal-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,23,0.68);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;}',
      '.sg-modal-card{width:100%;max-width:440px;border-radius:14px;padding:20px;box-shadow:0 24px 48px rgba(0,0,0,0.4);font-family:system-ui,-apple-system,sans-serif;}',
      '.sg-modal-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;}',
      '.sg-modal-close{background:transparent;border:1px solid currentColor;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:16px;line-height:1;opacity:0.75;color:inherit;}',
      '.sg-modal-close:hover{opacity:1;}',
      '.sg-modal-input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:8px;border:1px solid rgba(148,163,184,0.4);font:14px system-ui,sans-serif;margin-top:4px;margin-bottom:10px;}',
      '.sg-modal-submit{padding:9px 16px;border-radius:8px;border:0;font:600 14px system-ui,sans-serif;cursor:pointer;}',
      '.sg-cart-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:11px;font-weight:700;margin-left:6px;}'
    ].join('');
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function getPalette() {
    var bodyStyle = window.getComputedStyle ? window.getComputedStyle(document.body) : null;
    var bg = (bodyStyle && bodyStyle.backgroundColor) || 'rgb(15, 23, 42)';
    var m = bg.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
    var isDark = true;
    if (m) {
      var lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
      isDark = lum < 0.52;
    }
    return isDark
      ? {
          surface: '#111827',
          text: '#f8fafc',
          muted: '#94a3b8',
          border: 'rgba(148, 163, 184, 0.25)',
          accent: '#0284c7',
          inputBg: '#0b0f17',
          btnText: '#ffffff'
        }
      : {
          surface: '#ffffff',
          text: '#0f172a',
          muted: '#475569',
          border: 'rgba(15, 23, 42, 0.15)',
          accent: '#0284c7',
          inputBg: '#f8fafc',
          btnText: '#ffffff'
        };
  }

  function showToast(msg) {
    var old = document.getElementById('sg-runtime-toast');
    if (old) old.remove();
    var pal = getPalette();
    var toast = document.createElement('div');
    toast.id = 'sg-runtime-toast';
    toast.className = 'sg-toast';
    toast.setAttribute('role', 'status');
    toast.style.background = pal.surface;
    toast.style.color = pal.text;
    toast.style.border = '1px solid ' + pal.border;
    toast.textContent = msg;
    if (document.body) {
      document.body.appendChild(toast);
      setTimeout(function () {
        if (toast.parentNode) toast.remove();
      }, 3200);
    }
  }
  window.__sgToast = showToast;
  if (Array.isArray(window.__sgPendingToasts) && window.__sgPendingToasts.length > 0) {
    var pendingMsg = window.__sgPendingToasts[window.__sgPendingToasts.length - 1];
    window.__sgPendingToasts = [];
    setTimeout(function () { showToast(pendingMsg); }, 80);
  }

  if (window.origin === 'null') {
    window.alert = function (msg) {
      showToast(String(msg || 'Action completed'));
    };
    window.confirm = function (msg) {
      if (msg) showToast(String(msg));
      return true;
    };
    window.prompt = function (msg, def) {
      if (msg) showToast(String(msg));
      return def !== undefined ? String(def) : 'Demo Input';
    };
  }

  function safeGetStorage(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function safeSetStorage(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val));
    } catch (err) {}
  }

  function getAuthUser() {
    return safeGetStorage('sg_demo_user');
  }

  function getCartItems() {
    return safeGetStorage('sg_cart_items') || [];
  }

  function syncCartBadges() {
    var items = getCartItems();
    var totalQty = items.reduce(function (sum, it) { return sum + (it.qty || 1); }, 0);
    document.querySelectorAll('[data-sg-cart-badge]').forEach(function (b) {
      b.textContent = String(totalQty);
      b.style.display = totalQty > 0 ? 'inline-flex' : 'none';
    });
  }

  function applyAuthUiState() {
    var user = getAuthUser();
    document.querySelectorAll('[data-sg-auth-trigger="true"]').forEach(function (btn) {
      if (!btn.dataset.sgOrigText) {
        btn.dataset.sgOrigText = btn.textContent || 'Sign in';
      }
      if (user && user.name) {
        var initials = user.name.slice(0, 1).toUpperCase();
        btn.innerHTML = '';
        var badge = document.createElement('span');
        badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:999px;background:#0284c7;color:#fff;font-size:11px;font-weight:700;margin-right:6px;';
        badge.textContent = initials;
        var nm = document.createElement('span');
        nm.textContent = user.name.split(' ')[0];
        btn.appendChild(badge);
        btn.appendChild(nm);
        btn.setAttribute('title', 'Signed in as ' + user.email);
      } else {
        btn.textContent = btn.dataset.sgOrigText || 'Sign in';
        btn.removeAttribute('title');
      }
    });
  }

  function openAuthModal(triggerEl, labelText) {
    var existing = document.getElementById('sg-runtime-modal');
    if (existing) existing.remove();
    var pal = getPalette();
    var user = getAuthUser();

    var backdrop = document.createElement('div');
    backdrop.id = 'sg-runtime-modal';
    backdrop.className = 'sg-modal-backdrop';

    var card = document.createElement('div');
    card.className = 'sg-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.style.background = pal.surface;
    card.style.color = pal.text;
    card.style.border = '1px solid ' + pal.border;

    var hdr = document.createElement('div');
    hdr.className = 'sg-modal-header';
    var h = document.createElement('h3');
    h.style.margin = '0';
    h.style.fontSize = '17px';
    h.style.fontWeight = '700';
    h.textContent = user ? 'Account (' + user.name + ')' : (labelText || 'Sign In');
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sg-modal-close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { backdrop.remove(); });
    hdr.appendChild(h);
    hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    if (user) {
      var info = document.createElement('p');
      info.style.cssText = 'margin:0 0 14px;font-size:13.5px;color:' + pal.muted + ';';
      info.textContent = 'Signed in as ' + user.name + ' (' + user.email + '). Likes, subscriptions, and comments are saved to your session.';
      card.appendChild(info);

      var signOutBtn = document.createElement('button');
      signOutBtn.type = 'button';
      signOutBtn.className = 'sg-modal-submit';
      signOutBtn.style.background = '#dc2626';
      signOutBtn.style.color = '#ffffff';
      signOutBtn.textContent = 'Sign Out';
      signOutBtn.addEventListener('click', function () {
        try { window.localStorage.removeItem('sg_demo_user'); } catch (e) {}
        applyAuthUiState();
        backdrop.remove();
        showToast('Signed out.');
      });
      card.appendChild(signOutBtn);
    } else {
      var quickBtn = document.createElement('button');
      quickBtn.type = 'button';
      quickBtn.className = 'sg-modal-submit';
      quickBtn.style.cssText = 'width:100%;margin-bottom:12px;background:#0ea5e9;color:#fff;';
      quickBtn.textContent = 'Continue with Demo Account (Alex Morgan)';
      quickBtn.addEventListener('click', function () {
        safeSetStorage('sg_demo_user', { name: 'Alex Morgan', email: 'alex@demo.local' });
        if (triggerEl) triggerEl.setAttribute('data-sg-auth-trigger', 'true');
        applyAuthUiState();
        backdrop.remove();
        showToast('Signed in as Alex Morgan');
      });
      card.appendChild(quickBtn);

      var form = document.createElement('form');
      form.setAttribute('data-sg-modal-form', 'true');

      var lblName = document.createElement('label');
      lblName.style.cssText = 'display:block;font-size:12.5px;font-weight:600;';
      lblName.textContent = 'Display Name';
      var inName = document.createElement('input');
      inName.type = 'text';
      inName.required = true;
      inName.placeholder = 'Alex Morgan';
      inName.className = 'sg-modal-input';
      inName.style.background = pal.inputBg;
      inName.style.color = pal.text;
      lblName.appendChild(inName);
      form.appendChild(lblName);

      var lblEmail = document.createElement('label');
      lblEmail.style.cssText = 'display:block;font-size:12.5px;font-weight:600;';
      lblEmail.textContent = 'Email Address';
      var inEmail = document.createElement('input');
      inEmail.type = 'email';
      inEmail.required = true;
      inEmail.placeholder = 'you@example.com';
      inEmail.className = 'sg-modal-input';
      inEmail.style.background = pal.inputBg;
      inEmail.style.color = pal.text;
      lblEmail.appendChild(inEmail);
      form.appendChild(lblEmail);

      var subBtn = document.createElement('button');
      subBtn.type = 'submit';
      subBtn.className = 'sg-modal-submit';
      subBtn.style.background = pal.accent;
      subBtn.style.color = pal.btnText;
      subBtn.textContent = 'Sign In';
      form.appendChild(subBtn);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var nm = inName.value.trim() || inEmail.value.split('@')[0];
        var em = inEmail.value.trim();
        safeSetStorage('sg_demo_user', { name: nm, email: em });
        if (triggerEl) triggerEl.setAttribute('data-sg-auth-trigger', 'true');
        applyAuthUiState();
        backdrop.remove();
        showToast('Signed in as ' + nm);
      });
      card.appendChild(form);
    }

    backdrop.appendChild(card);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
  }

  function openMediaPlayerModal(cardEl, fallbackTitle) {
    var existing = document.getElementById('sg-runtime-modal');
    if (existing) existing.remove();

    var pal = getPalette();
    var hEl = cardEl ? cardEl.querySelector('h1, h2, h3, h4, .title, [class*="title"]') : null;
    var title = (hEl ? hEl.textContent : fallbackTitle || 'Featured Video').replace(/\\s+/g, ' ').trim().slice(0, 80);
    var chEl = cardEl ? cardEl.querySelector('.channel, .author, [class*="channel"], [class*="author"], small, span') : null;
    var channel = (chEl && chEl !== hEl ? chEl.textContent : 'Creator Studio').replace(/\\s+/g, ' ').trim().slice(0, 48);
    var vidKey = 'sg_vid_' + title.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32);
    var vidState = safeGetStorage(vidKey) || { liked: false, likes: 1420, subscribed: false, saved: false, comments: ['Clean playback and great pacing!'] };

    var backdrop = document.createElement('div');
    backdrop.id = 'sg-runtime-modal';
    backdrop.className = 'sg-modal-backdrop';

    var card = document.createElement('div');
    card.className = 'sg-modal-card';
    card.style.maxWidth = '640px';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.style.background = pal.surface;
    card.style.color = pal.text;
    card.style.border = '1px solid ' + pal.border;

    var hdr = document.createElement('div');
    hdr.className = 'sg-modal-header';
    var h = document.createElement('h3');
    h.style.cssText = 'margin:0;font-size:16px;font-weight:700;';
    h.textContent = title;
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sg-modal-close';
    closeBtn.textContent = '×';
    var rafId = 0;
    var cleanup = function () {
      if (rafId) cancelAnimationFrame(rafId);
      backdrop.remove();
    };
    closeBtn.addEventListener('click', cleanup);
    hdr.appendChild(h);
    hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    var canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'position:relative;border-radius:10px;overflow:hidden;background:#020617;margin-bottom:10px;';
    var canvas = document.createElement('canvas');
    canvas.width = 590;
    canvas.height = 240;
    canvas.style.cssText = 'display:block;width:100%;height:auto;';
    canvasWrap.appendChild(canvas);
    card.appendChild(canvasWrap);

    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:12px;';
    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'sg-modal-submit';
    playBtn.style.cssText = 'padding:6px 12px;font-size:12px;background:' + pal.accent + ';color:#fff;';
    playBtn.textContent = 'Pause';
    var scrubber = document.createElement('input');
    scrubber.type = 'range';
    scrubber.min = '0';
    scrubber.max = '260';
    scrubber.value = '0';
    scrubber.style.flex = '1';
    var timeLabel = document.createElement('span');
    timeLabel.style.fontFamily = 'monospace';
    timeLabel.textContent = '0:00 / 4:20';
    controls.appendChild(playBtn);
    controls.appendChild(scrubber);
    controls.appendChild(timeLabel);
    card.appendChild(controls);

    var playing = true;
    var tSec = 0;
    var lastTs = performance.now();
    var ctx = canvas.getContext('2d');
    function fmtTime(sec) {
      var m = Math.floor(sec / 60);
      var s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function drawFrame(now) {
      var dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      if (playing) {
        tSec = (tSec + dt) % 260;
        scrubber.value = String(Math.floor(tSec));
      }
      timeLabel.textContent = fmtTime(tSec) + ' / 4:20';
      if (ctx) {
        var g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        var hue = (tSec * 24) % 360;
        g.addColorStop(0, 'hsl(' + hue + ', 68%, 16%)');
        g.addColorStop(1, 'hsl(' + ((hue + 80) % 360) + ', 75%, 24%)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        for (var i = 0; i < 16; i++) {
          var bh = 28 + Math.abs(Math.sin(tSec * 3.2 + i * 0.6)) * (playing ? 76 : 12);
          ctx.fillStyle = 'rgba(56,189,248,0.65)';
          ctx.fillRect(24 + i * 34, canvas.height - bh - 20, 22, bh);
        }
        ctx.fillStyle = '#f8fafc';
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.fillText(title.slice(0, 48), 24, 38);
        ctx.fillStyle = 'rgba(226,232,240,0.75)';
        ctx.font = '13px system-ui, sans-serif';
        ctx.fillText(channel + (playing ? '  •  Playing' : '  •  Paused'), 24, 60);
      }
      rafId = requestAnimationFrame(drawFrame);
    }
    rafId = requestAnimationFrame(drawFrame);

    playBtn.addEventListener('click', function () {
      playing = !playing;
      playBtn.textContent = playing ? 'Pause' : 'Play';
    });
    scrubber.addEventListener('input', function () {
      tSec = Number(scrubber.value) || 0;
    });

    var actionRow = document.createElement('div');
    actionRow.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:14px;';
    var likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'sg-modal-submit';
    var subBtn = document.createElement('button');
    subBtn.type = 'button';
    subBtn.className = 'sg-modal-submit';
    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'sg-modal-submit';
    function syncActions() {
      likeBtn.style.background = vidState.liked ? '#0284c7' : 'rgba(148,163,184,0.22)';
      likeBtn.style.color = vidState.liked ? '#fff' : pal.text;
      likeBtn.textContent = (vidState.liked ? 'Liked (' : 'Like (') + vidState.likes + ')';
      subBtn.style.background = vidState.subscribed ? '#334155' : '#dc2626';
      subBtn.style.color = '#fff';
      subBtn.textContent = vidState.subscribed ? 'Subscribed' : 'Subscribe';
      saveBtn.style.background = vidState.saved ? '#059669' : 'rgba(148,163,184,0.22)';
      saveBtn.style.color = vidState.saved ? '#fff' : pal.text;
      saveBtn.textContent = vidState.saved ? 'Saved to Watch Later' : 'Watch Later';
    }
    syncActions();
    likeBtn.addEventListener('click', function () {
      vidState.liked = !vidState.liked;
      vidState.likes += vidState.liked ? 1 : -1;
      safeSetStorage(vidKey, vidState);
      syncActions();
    });
    subBtn.addEventListener('click', function () {
      vidState.subscribed = !vidState.subscribed;
      safeSetStorage(vidKey, vidState);
      syncActions();
      showToast(vidState.subscribed ? 'Subscribed to ' + channel : 'Unsubscribed');
    });
    saveBtn.addEventListener('click', function () {
      vidState.saved = !vidState.saved;
      safeSetStorage(vidKey, vidState);
      syncActions();
      showToast(vidState.saved ? 'Saved to Watch Later' : 'Removed from Watch Later');
    });
    actionRow.appendChild(subBtn);
    actionRow.appendChild(likeBtn);
    actionRow.appendChild(saveBtn);
    card.appendChild(actionRow);

    var commentForm = document.createElement('form');
    commentForm.setAttribute('data-sg-modal-form', 'true');
    commentForm.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
    var commentIn = document.createElement('input');
    commentIn.type = 'text';
    commentIn.required = true;
    commentIn.placeholder = 'Add a comment...';
    commentIn.className = 'sg-modal-input';
    commentIn.style.cssText = 'flex:1;margin:0;background:' + pal.inputBg + ';color:' + pal.text + ';';
    var commentPost = document.createElement('button');
    commentPost.type = 'submit';
    commentPost.className = 'sg-modal-submit';
    commentPost.style.cssText = 'background:' + pal.accent + ';color:#fff;padding:8px 14px;';
    commentPost.textContent = 'Comment';
    commentForm.appendChild(commentIn);
    commentForm.appendChild(commentPost);
    card.appendChild(commentForm);

    var commentList = document.createElement('div');
    commentList.style.cssText = 'max-height:110px;overflow:auto;display:grid;gap:6px;font-size:12.5px;';
    function renderComments() {
      commentList.innerHTML = '';
      (vidState.comments || []).slice().reverse().forEach(function (txt) {
        var row = document.createElement('div');
        row.style.cssText = 'padding:6px 9px;border-radius:7px;background:rgba(148,163,184,0.12);';
        row.textContent = txt;
        commentList.appendChild(row);
      });
    }
    renderComments();
    commentForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var val = commentIn.value.trim();
      if (!val) return;
      var u = getAuthUser();
      var prefix = (u && u.name ? u.name : 'Guest') + ': ';
      vidState.comments = (vidState.comments || []).concat([prefix + val]);
      safeSetStorage(vidKey, vidState);
      commentIn.value = '';
      renderComments();
    });
    card.appendChild(commentList);

    backdrop.appendChild(card);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) cleanup();
    });
    document.body.appendChild(backdrop);
  }

  function openActionModal(triggerEl, labelText) {
    var existing = document.getElementById('sg-runtime-modal');
    if (existing) existing.remove();

    var pal = getPalette();
    var cardCtx = triggerEl.closest('article, section, .card, .pricing-card, [class*="card"]');
    var headingEl = cardCtx ? cardCtx.querySelector('h1, h2, h3, h4') : null;
    var contextTitle = headingEl ? headingEl.textContent.trim().slice(0, 64) : '';
    var titleText = labelText || 'Action Details';

    var backdrop = document.createElement('div');
    backdrop.id = 'sg-runtime-modal';
    backdrop.className = 'sg-modal-backdrop';

    var card = document.createElement('div');
    card.className = 'sg-modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.style.background = pal.surface;
    card.style.color = pal.text;
    card.style.border = '1px solid ' + pal.border;

    var hdr = document.createElement('div');
    hdr.className = 'sg-modal-header';

    var titleWrap = document.createElement('div');
    var h = document.createElement('h3');
    h.style.margin = '0';
    h.style.fontSize = '17px';
    h.style.fontWeight = '700';
    h.textContent = titleText;
    titleWrap.appendChild(h);

    if (contextTitle && contextTitle.toLowerCase() !== titleText.toLowerCase()) {
      var sub = document.createElement('p');
      sub.style.margin = '4px 0 0';
      sub.style.fontSize = '13px';
      sub.style.color = pal.muted;
      sub.textContent = contextTitle;
      titleWrap.appendChild(sub);
    }

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'sg-modal-close';
    closeBtn.setAttribute('aria-label', 'Close dialog');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () {
      backdrop.remove();
    });

    hdr.appendChild(titleWrap);
    hdr.appendChild(closeBtn);
    card.appendChild(hdr);

    var desc = document.createElement('p');
    desc.style.margin = '0 0 12px';
    desc.style.fontSize = '13.5px';
    desc.style.lineHeight = '1.5';
    desc.style.color = pal.muted;
    desc.textContent = 'Complete your action below or confirm to proceed.';
    card.appendChild(desc);

    var form = document.createElement('form');
    form.setAttribute('data-sg-modal-form', 'true');

    var isAuth = /sign in|log in|login|account|register|sign up/i.test(titleText);
    var label1 = document.createElement('label');
    label1.style.display = 'block';
    label1.style.fontSize = '12.5px';
    label1.style.fontWeight = '600';
    label1.textContent = isAuth ? 'Email Address' : 'Name or Email';
    var input1 = document.createElement('input');
    input1.type = isAuth ? 'email' : 'text';
    input1.required = true;
    input1.placeholder = isAuth ? 'you@example.com' : 'Enter your name or email...';
    input1.className = 'sg-modal-input';
    input1.style.background = pal.inputBg;
    input1.style.color = pal.text;
    label1.appendChild(input1);
    form.appendChild(label1);

    var label2 = document.createElement('label');
    label2.style.display = 'block';
    label2.style.fontSize = '12.5px';
    label2.style.fontWeight = '600';
    label2.textContent = isAuth ? 'Access Code / Password' : 'Notes or Selection';
    var input2 = document.createElement('input');
    input2.type = isAuth ? 'password' : 'text';
    input2.placeholder = isAuth ? '••••••••' : 'Optional details...';
    input2.className = 'sg-modal-input';
    input2.style.background = pal.inputBg;
    input2.style.color = pal.text;
    label2.appendChild(input2);
    form.appendChild(label2);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'sg-modal-submit';
    submitBtn.style.background = pal.accent;
    submitBtn.style.color = pal.btnText;
    submitBtn.textContent = 'Confirm ' + titleText.slice(0, 24);
    form.appendChild(submitBtn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var entered = input1.value.trim();
      backdrop.remove();
      showToast(titleText + ' confirmed' + (entered ? ' for ' + entered : '') + '.');
    });

    card.appendChild(form);
    backdrop.appendChild(card);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    setTimeout(function () {
      try { input1.focus(); } catch (err) {}
    }, 20);
  }

  function findFilterContainer(triggerEl) {
    var root = triggerEl.closest('section, main') || document.body;
    var candidates = root.querySelectorAll('article, .card, [class*="card"], .item, [data-category], [data-filter-item], tbody tr');
    return candidates.length >= 2 ? candidates : null;
  }

  function runFallbackClickAction(el) {
    var label = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\\s+/g, ' ').trim();
    var lower = label.toLowerCase();

    // A. Mobile navigation / drawer toggle
    if (
      el.matches('[data-nav-toggle], .menu-toggle, .nav-toggle, [aria-controls]') ||
      /menu|hamburger|toggle navigation/i.test(lower)
    ) {
      var targetId = el.getAttribute('aria-controls') || el.getAttribute('data-nav-toggle');
      var nav = targetId
        ? document.getElementById(targetId)
        : document.querySelector('header nav, nav ul, .nav-links, .mobile-menu');
      if (nav) {
        var expanded = el.getAttribute('aria-expanded') === 'true';
        el.setAttribute('aria-expanded', String(!expanded));
        nav.classList.toggle('is-open');
        nav.classList.toggle('open');
        nav.classList.toggle('active');
        nav.classList.toggle('sg-nav-open');
        if (nav.hasAttribute('hidden')) nav.removeAttribute('hidden');
        return;
      }
    }

    // B. Dropdown triggers
    if (el.hasAttribute('aria-haspopup') || el.classList.contains('dropdown-toggle')) {
      var wrap = el.closest('.dropdown, [class*="dropdown"]') || el.parentElement;
      var menu = wrap ? wrap.querySelector('.dropdown-menu, [role="menu"], ul') : null;
      if (menu) {
        var isExp = el.getAttribute('aria-expanded') === 'true';
        el.setAttribute('aria-expanded', String(!isExp));
        menu.classList.toggle('open');
        menu.classList.toggle('is-open');
        if (menu.hasAttribute('hidden')) menu.removeAttribute('hidden');
        return;
      }
    }

    // C. Tabs
    if (el.matches('[role="tab"], [data-tab]')) {
      var tabTarget = el.getAttribute('data-tab') || el.getAttribute('aria-controls');
      var tabGroup = el.closest('[role="tablist"], .tabs, .tab-bar') || el.parentElement;
      if (tabGroup) {
        tabGroup.querySelectorAll('[role="tab"], [data-tab]').forEach(function (sib) {
          sib.classList.remove('active', 'is-active');
          sib.setAttribute('aria-selected', 'false');
        });
      }
      el.classList.add('active', 'is-active');
      el.setAttribute('aria-selected', 'true');
      if (tabTarget) {
        var panel = document.getElementById(tabTarget) || document.querySelector('[data-tab-panel="' + tabTarget + '"]');
        if (panel && panel.parentElement) {
          Array.prototype.forEach.call(panel.parentElement.children, function (child) {
            if (child.getAttribute('role') === 'tabpanel' || child.hasAttribute('data-tab-panel')) {
              child.hidden = child !== panel;
              child.classList.toggle('active', child === panel);
            }
          });
        }
      }
      return;
    }

    // D. Category / Filter pills
    if (
      el.hasAttribute('data-filter') ||
      el.hasAttribute('data-category') ||
      el.closest('.filters, .filter-bar, .filter-pills, [role="group"]')
    ) {
      var filterGroup = el.closest('.filters, .filter-bar, .filter-pills, [role="group"]') || el.parentElement;
      if (filterGroup) {
        filterGroup.querySelectorAll('button, [role="button"]').forEach(function (b) {
          b.classList.remove('active', 'is-active');
          b.setAttribute('aria-pressed', 'false');
        });
      }
      el.classList.add('active', 'is-active');
      el.setAttribute('aria-pressed', 'true');

      var filterKey = (el.getAttribute('data-filter') || el.getAttribute('data-category') || lower).trim().toLowerCase();
      var cards = findFilterContainer(el);
      if (cards && filterKey) {
        var shown = 0;
        cards.forEach(function (card) {
          var cCat = (card.getAttribute('data-category') || card.getAttribute('data-filter') || '').toLowerCase();
          var cTxt = (card.textContent || '').toLowerCase();
          var matches = filterKey === 'all' || cCat.indexOf(filterKey) !== -1 || cTxt.indexOf(filterKey) !== -1;
          card.classList.toggle('sg-runtime-hidden', !matches);
          if (matches) shown += 1;
        });
        showToast('Showing ' + shown + ' item' + (shown === 1 ? '' : 's') + (filterKey === 'all' ? '' : ' for "' + label + '"'));
        return;
      }
    }

    // E. Accordion / FAQ toggle
    var accItem = el.closest('.accordion-item, .faq-item, [data-accordion-item]');
    if (accItem || el.hasAttribute('aria-expanded')) {
      var panelEl = accItem
        ? accItem.querySelector('.accordion-content, .accordion-body, .faq-answer, [data-accordion-content], p, div:last-child')
        : el.nextElementSibling;
      if (panelEl && panelEl !== el) {
        var wasOpen = el.getAttribute('aria-expanded') === 'true' || !panelEl.classList.contains('sg-runtime-hidden');
        if (el.hasAttribute('aria-expanded')) {
          wasOpen = el.getAttribute('aria-expanded') === 'true';
        }
        el.setAttribute('aria-expanded', String(!wasOpen));
        panelEl.classList.toggle('sg-runtime-hidden', wasOpen);
        panelEl.hidden = wasOpen;
        return;
      }
    }

    // F. Pricing / Billing toggle (Monthly vs Annual) & Theme toggle
    if (
      el.hasAttribute('data-billing-toggle') ||
      /monthly|annual|yearly|billed yearly|billed monthly/i.test(lower)
    ) {
      var group = el.closest('.toggle, .billing-toggle, .tabs, [role="group"]') || el.parentElement;
      if (group) {
        group.querySelectorAll('button, [role="button"]').forEach(function (b) {
          b.classList.remove('active', 'is-active');
          b.setAttribute('aria-pressed', 'false');
        });
      }
      el.classList.add('active', 'is-active');
      el.setAttribute('aria-pressed', 'true');
      var isAnnual = /annual|yearly|year/i.test(lower) || (el.getAttribute('aria-pressed') === 'true' && !/monthly/i.test(lower));
      document.querySelectorAll('[data-monthly-price], [data-annual-price]').forEach(function (priceEl) {
        var nextVal = isAnnual ? priceEl.getAttribute('data-annual-price') : priceEl.getAttribute('data-monthly-price');
        if (nextVal) priceEl.textContent = nextVal;
      });
      showToast('Billing view switched to ' + (isAnnual ? 'Annual' : 'Monthly') + ' pricing');
      return;
    }

    if (el.hasAttribute('data-theme-toggle') || /dark mode|light mode|toggle theme/i.test(lower)) {
      var isDarkNow = document.documentElement.getAttribute('data-theme') !== 'light' && !document.body.classList.contains('light-mode');
      document.documentElement.setAttribute('data-theme', isDarkNow ? 'light' : 'dark');
      document.body.classList.toggle('light-mode', isDarkNow);
      document.body.classList.toggle('dark-mode', !isDarkNow);
      showToast('Switched to ' + (isDarkNow ? 'Light' : 'Dark') + ' theme');
      return;
    }

    // G. Shopping Cart / Bag / Checkout drawer
    function openCartDrawer() {
      var existing = document.getElementById('sg-runtime-modal');
      if (existing) existing.remove();
      var pal = getPalette();
      var backdrop = document.createElement('div');
      backdrop.id = 'sg-runtime-modal';
      backdrop.className = 'sg-modal-backdrop';
      backdrop.style.justifyContent = 'flex-end';
      backdrop.style.padding = '0';

      var card = document.createElement('div');
      card.className = 'sg-modal-card';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.style.cssText = 'max-width:420px;height:100%;border-radius:0;display:flex;flex-direction:column;justify-content:space-between;background:' + pal.surface + ';color:' + pal.text + ';border-left:1px solid ' + pal.border + ';';

      var top = document.createElement('div');
      top.style.cssText = 'overflow:auto;flex:1;';
      var hdr = document.createElement('div');
      hdr.className = 'sg-modal-header';
      var h = document.createElement('h3');
      h.style.cssText = 'margin:0;font-size:17px;font-weight:700;';
      h.textContent = 'Shopping Cart';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sg-modal-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', function () { backdrop.remove(); });
      hdr.appendChild(h);
      hdr.appendChild(closeBtn);
      top.appendChild(hdr);

      var listEl = document.createElement('div');
      listEl.style.cssText = 'display:grid;gap:10px;margin-top:10px;';
      top.appendChild(listEl);

      var footer = document.createElement('div');
      footer.style.cssText = 'border-top:1px solid ' + pal.border + ';padding-top:12px;margin-top:12px;';
      var promoRow = document.createElement('div');
      promoRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;';
      var promoIn = document.createElement('input');
      promoIn.type = 'text';
      promoIn.placeholder = 'Promo code (try SAVE10)';
      promoIn.className = 'sg-modal-input';
      promoIn.style.cssText = 'flex:1;margin:0;background:' + pal.inputBg + ';color:' + pal.text + ';';
      var promoBtn = document.createElement('button');
      promoBtn.type = 'button';
      promoBtn.className = 'sg-modal-submit';
      promoBtn.style.cssText = 'padding:8px 12px;background:rgba(148,163,184,0.22);color:' + pal.text + ';';
      promoBtn.textContent = 'Apply';
      promoRow.appendChild(promoIn);
      promoRow.appendChild(promoBtn);
      footer.appendChild(promoRow);

      var totalRow = document.createElement('div');
      totalRow.style.cssText = 'display:flex;justify-content:space-between;font-weight:700;font-size:15px;margin-bottom:10px;';
      footer.appendChild(totalRow);

      var checkoutBtn = document.createElement('button');
      checkoutBtn.type = 'button';
      checkoutBtn.className = 'sg-modal-submit';
      checkoutBtn.style.cssText = 'width:100%;background:' + pal.accent + ';color:#fff;';
      checkoutBtn.textContent = 'Proceed to Checkout';
      footer.appendChild(checkoutBtn);

      var discountPct = 0;
      function renderCart() {
        var items = getCartItems();
        listEl.innerHTML = '';
        if (items.length === 0) {
          var empty = document.createElement('p');
          empty.style.cssText = 'font-size:13.5px;color:' + pal.muted + ';';
          empty.textContent = 'Your cart is empty. Click "Add to Cart" or "Buy" on any item.';
          listEl.appendChild(empty);
        } else {
          items.forEach(function (item, idx) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border-radius:10px;border:1px solid ' + pal.border + ';';
            var meta = document.createElement('div');
            meta.innerHTML = '<div style="font-weight:600;font-size:13.5px;"></div><div style="font-size:12px;opacity:0.75;"></div>';
            meta.children[0].textContent = item.title;
            meta.children[1].textContent = '$' + Number(item.price).toFixed(2) + ' each';
            var qtyCtrl = document.createElement('div');
            qtyCtrl.style.cssText = 'display:flex;align-items:center;gap:6px;';
            var dec = document.createElement('button');
            dec.type = 'button';
            dec.textContent = '-';
            dec.className = 'sg-modal-close';
            var qty = document.createElement('span');
            qty.textContent = String(item.qty || 1);
            var inc = document.createElement('button');
            inc.type = 'button';
            inc.textContent = '+';
            inc.className = 'sg-modal-close';
            dec.addEventListener('click', function () {
              if (item.qty > 1) item.qty -= 1;
              else items.splice(idx, 1);
              safeSetStorage('sg_cart_items', items);
              syncCartBadges();
              renderCart();
            });
            inc.addEventListener('click', function () {
              item.qty += 1;
              safeSetStorage('sg_cart_items', items);
              syncCartBadges();
              renderCart();
            });
            qtyCtrl.appendChild(dec);
            qtyCtrl.appendChild(qty);
            qtyCtrl.appendChild(inc);
            row.appendChild(meta);
            row.appendChild(qtyCtrl);
            listEl.appendChild(row);
          });
        }
        var sub = items.reduce(function (s, it) { return s + Number(it.price) * (it.qty || 1); }, 0);
        var finalTotal = sub * (1 - discountPct);
        totalRow.innerHTML = '<span>Total' + (discountPct > 0 ? ' (10% off)' : '') + '</span><span>$' + finalTotal.toFixed(2) + '</span>';
        checkoutBtn.disabled = items.length === 0;
        checkoutBtn.style.opacity = items.length === 0 ? '0.5' : '1';
      }

      promoBtn.addEventListener('click', function () {
        if (promoIn.value.trim().toUpperCase() === 'SAVE10') {
          discountPct = 0.1;
          renderCart();
          showToast('Promo code SAVE10 applied (10% off)!');
        } else {
          showToast('Try promo code SAVE10 for 10% off.');
        }
      });

      checkoutBtn.addEventListener('click', function () {
        safeSetStorage('sg_cart_items', []);
        syncCartBadges();
        backdrop.remove();
        showToast('Order placed! Confirmation sent to your session.');
      });

      renderCart();
      card.appendChild(top);
      card.appendChild(footer);
      backdrop.appendChild(card);
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) backdrop.remove();
      });
      document.body.appendChild(backdrop);
    }

    function openCreateModal(labelText) {
      var existing = document.getElementById('sg-runtime-modal');
      if (existing) existing.remove();
      var pal = getPalette();
      var backdrop = document.createElement('div');
      backdrop.id = 'sg-runtime-modal';
      backdrop.className = 'sg-modal-backdrop';
      var card = document.createElement('div');
      card.className = 'sg-modal-card';
      card.style.background = pal.surface;
      card.style.color = pal.text;
      card.style.border = '1px solid ' + pal.border;

      var hdr = document.createElement('div');
      hdr.className = 'sg-modal-header';
      var h = document.createElement('h3');
      h.style.cssText = 'margin:0;font-size:17px;font-weight:700;';
      h.textContent = labelText || 'Create New Item';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sg-modal-close';
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', function () { backdrop.remove(); });
      hdr.appendChild(h);
      hdr.appendChild(closeBtn);
      card.appendChild(hdr);

      var form = document.createElement('form');
      form.setAttribute('data-sg-modal-form', 'true');
      var inTitle = document.createElement('input');
      inTitle.type = 'text';
      inTitle.required = true;
      inTitle.placeholder = 'Title (e.g., My New Video or Post)...';
      inTitle.className = 'sg-modal-input';
      inTitle.style.cssText = 'background:' + pal.inputBg + ';color:' + pal.text + ';';
      var inDesc = document.createElement('input');
      inDesc.type = 'text';
      inDesc.placeholder = 'Description or category...';
      inDesc.className = 'sg-modal-input';
      inDesc.style.cssText = 'background:' + pal.inputBg + ';color:' + pal.text + ';';
      var sub = document.createElement('button');
      sub.type = 'submit';
      sub.className = 'sg-modal-submit';
      sub.style.cssText = 'background:' + pal.accent + ';color:#fff;';
      sub.textContent = 'Publish Now';
      form.appendChild(inTitle);
      form.appendChild(inDesc);
      form.appendChild(sub);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var t = inTitle.value.trim();
        var d = inDesc.value.trim() || 'Published just now';
        var feed = document.querySelector('.video-grid, .grid, main section > div, main ul, main');
        if (feed) {
          var firstCard = feed.querySelector('article, .video-card, .card, [class*="card"]');
          var clone = firstCard ? firstCard.cloneNode(true) : document.createElement('article');
          if (!firstCard) {
            clone.className = 'sg-card';
            clone.style.cssText = 'padding:14px;border-radius:12px;border:1px solid ' + pal.border + ';';
          }
          var heading = clone.querySelector('h1, h2, h3, h4, .title');
          if (heading) heading.textContent = t;
          else {
            var nh = document.createElement('h3');
            nh.textContent = t;
            clone.prepend(nh);
          }
          var meta = clone.querySelector('p, .meta, .channel, .author');
          if (meta) {
            var u = getAuthUser();
            meta.textContent = (u && u.name ? u.name : 'You') + ' · ' + d;
          }
          if (firstCard && firstCard.parentElement) firstCard.parentElement.prepend(clone);
          else feed.prepend(clone);
        }
        backdrop.remove();
        showToast('Published "' + t + '"!');
      });

      card.appendChild(form);
      backdrop.appendChild(card);
      backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.remove(); });
      document.body.appendChild(backdrop);
      setTimeout(function () { try { inTitle.focus(); } catch (err) {} }, 20);
    }

    // Semantic route check for links rewritten from uncaptured same-origin URLs
    var sgRoute = (el.getAttribute('data-sg-route') || el.getAttribute('data-sitegrab-uncaptured') || '').toLowerCase();

    // G1. Sign In / Account triggers
    if (/sign in|log in|login|sign up|create account|account/i.test(lower) || /\\/(login|signin|sign-in|signup|sign-up|register|auth|account)/.test(sgRoute)) {
      openAuthModal(el, label);
      return;
    }

    // G2. Notifications bell popover
    if (/notification|alerts|bell/i.test(lower) || /\\/notifications/.test(sgRoute)) {
      var oldNotif = document.getElementById('sg-runtime-modal');
      if (oldNotif) oldNotif.remove();
      var npal = getPalette();
      var nbd = document.createElement('div');
      nbd.id = 'sg-runtime-modal';
      nbd.className = 'sg-modal-backdrop';
      var ncard = document.createElement('div');
      ncard.className = 'sg-modal-card';
      ncard.style.cssText = 'background:' + npal.surface + ';color:' + npal.text + ';border:1px solid ' + npal.border + ';';
      ncard.innerHTML = '<div class="sg-modal-header"><h3 style="margin:0;font-size:17px;font-weight:700;">Notifications</h3><button type="button" class="sg-modal-close">×</button></div><div style="display:grid;gap:8px;font-size:13px;"><div style="padding:10px;border-radius:8px;border:1px solid ' + npal.border + ';">New upload from subscribed channel · 5m ago</div><div style="padding:10px;border-radius:8px;border:1px solid ' + npal.border + ';">Welcome! All notifications are up to date · Today</div></div>';
      ncard.querySelector('.sg-modal-close').addEventListener('click', function () { nbd.remove(); });
      nbd.appendChild(ncard);
      nbd.addEventListener('click', function (e) { if (e.target === nbd) nbd.remove(); });
      document.body.appendChild(nbd);
      return;
    }

    // G3. Create / Upload / New Post
    if (/^(create|upload|new post|compose|post|\\+ new|upload video)$/i.test(lower) || /\\/(upload|create|compose)/.test(sgRoute)) {
      openCreateModal(label);
      return;
    }

    // G4. Cart Drawer vs Add to Cart
    if (/^(cart|bag|basket|shopping cart|view cart|checkout)$/i.test(lower) || /\\/(cart|bag|checkout)/.test(sgRoute)) {
      openCartDrawer();
      return;
    }
    if (/add to cart|add to bag|buy now|order now/i.test(lower)) {
      var prodCard = el.closest('article, .card, [class*="card"], [data-product-id]');
      var prodTitleEl = prodCard ? prodCard.querySelector('h1, h2, h3, h4, .title') : null;
      var prodTitle = prodTitleEl ? prodTitleEl.textContent.trim().slice(0, 56) : (label || 'Selected Item');
      var priceMatch = prodCard ? (prodCard.textContent || '').match(/\\$\\s*(\\d+(?:\\.\\d{1,2})?)/) : null;
      var priceVal = priceMatch ? Number(priceMatch[1]) : 29.99;
      var items = getCartItems();
      var found = items.find(function (it) { return it.title === prodTitle; });
      if (found) found.qty += 1;
      else items.push({ title: prodTitle, price: priceVal, qty: 1 });
      safeSetStorage('sg_cart_items', items);
      syncCartBadges();
      showToast('Added "' + prodTitle + '" to cart ($' + priceVal.toFixed(2) + ')');
      return;
    }

    // H. Video / Media card triggers
    var mediaCard = el.closest('[data-video-id], .video-card, .video-item, [class*="video-card"], [class*="media-card"]');
    if (
      mediaCard ||
      /watch now|play video|watch video|play track|watch/i.test(lower) ||
      /\\/(watch|video|shorts)/.test(sgRoute) ||
      (/\\b\\d{1,2}:\\d{2}\\b/.test(el.textContent || '') && el.closest('article, .card, [class*="card"]'))
    ) {
      openMediaPlayerModal(mediaCard || el.closest('article, .card, [class*="card"]') || el, label);
      return;
    }

    // I. Interactive Like / Subscribe / Follow / Bookmark / Share toggles
    if (/^(like|liked|upvote|favorite|bookmark|save|saved|follow|following|subscribe|subscribed)\\b/i.test(lower)) {
      var wasActive = el.classList.contains('active') || el.getAttribute('aria-pressed') === 'true';
      el.classList.toggle('active', !wasActive);
      el.setAttribute('aria-pressed', String(!wasActive));
      var numMatch = (el.textContent || '').match(/\\d+/);
      if (numMatch) {
        var n = Number(numMatch[0]) + (wasActive ? -1 : 1);
        el.textContent = el.textContent.replace(numMatch[0], String(Math.max(0, n)));
      }
      showToast((!wasActive ? 'Updated: ' : 'Removed: ') + (label || 'saved'));
      return;
    }
    if (/^share\\b/i.test(lower)) {
      showToast('Share link copied to clipboard!');
      return;
    }

    // J. Smooth scroll or switch view if button matches an on-page section ID / data-view
    var slug = (sgRoute || lower).replace(/^.*\\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) {
      var matchingView = document.querySelector('[data-view="' + slug + '"], [data-tab="' + slug + '"], [id="' + slug + '"]');
      if (matchingView && matchingView !== el) {
        if (matchingView.tagName === 'BUTTON' || matchingView.hasAttribute('data-tab')) {
          matchingView.click();
          return;
        }
        matchingView.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }

    // K. Interactive action modal for CTAs & dead buttons/links
    openActionModal(el, label);
  }

  function unblockFrozenOverlays() {
    try {
      var selector = '#preloader, .preloader, .loading-screen, .page-loader, #loading-overlay, #onetrust-banner-sdk, #CybotCookiebotDialog, .cookie-consent-overlay, [class*="cookie-wall"]';
      document.querySelectorAll(selector).forEach(function (el) {
        if (el.id === 'sg-runtime-modal') return;
        var st = window.getComputedStyle(el);
        if (st && (st.position === 'fixed' || st.position === 'sticky') && st.display !== 'none') {
          el.style.setProperty('display', 'none', 'important');
          el.style.setProperty('pointer-events', 'none', 'important');
        }
      });
      if (document.body && !document.getElementById('sg-runtime-modal')) {
        var bStyle = window.getComputedStyle(document.body);
        if (bStyle && bStyle.overflow === 'hidden') {
          document.body.style.overflow = '';
        }
        if (document.documentElement) {
          var hStyle = window.getComputedStyle(document.documentElement);
          if (hStyle && hStyle.overflow === 'hidden') {
            document.documentElement.style.overflow = '';
          }
        }
      }
    } catch (err) {}
  }

  function syncDynamicInteractiveTags() {
    try {
      document.querySelectorAll('button, a[role="button"], a[href="#"], a[data-sg-route], a[data-sitegrab-uncaptured]').forEach(function (btn) {
        var txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
        var routeHint = (btn.getAttribute('data-sg-route') || btn.getAttribute('data-sitegrab-uncaptured') || '').toLowerCase();
        if (/^(sign in|log in|login|sign up|create account|account)$/i.test(txt) || /\\/(login|signin|sign-in|signup|account)/.test(routeHint)) {
          btn.setAttribute('data-sg-auth-trigger', 'true');
        }
        if (/^(cart|bag|basket|shopping cart)$/i.test(txt) && !btn.querySelector('[data-sg-cart-badge]')) {
          var cBadge = document.createElement('span');
          cBadge.className = 'sg-cart-badge';
          cBadge.setAttribute('data-sg-cart-badge', 'true');
          cBadge.style.cssText = 'background:#0284c7;color:#fff;display:none;';
          btn.appendChild(cBadge);
        }
      });
      applyAuthUiState();
      syncCartBadges();
    } catch (err) {}
  }

  function bootstrapSiteGrabRuntime() {
    if (window.__sgRuntimeBooted) return;
    window.__sgRuntimeBooted = true;

    syncDynamicInteractiveTags();
    unblockFrozenOverlays();
    setTimeout(unblockFrozenOverlays, 650);
    setTimeout(unblockFrozenOverlays, 1600);

    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'sitegrab:preview-ready', title: document.title || '' }, '*');
      }
    } catch (err) {}

    // Delegated click handler (capture + bubble) so buttons, anchors, external links, and dynamic controls always respond
    var activeSnap = null;
    document.addEventListener(
      'click',
      function (ev) {
        if (!ev.target || !ev.target.closest) return;
        if (ev.target.closest('#sg-runtime-modal')) return;

        // Handle in-page anchor links smoothly (including dynamically rendered ones)
        var rawAnchor = ev.target.closest('a[href]');
        if (rawAnchor) {
          var rawHref = (rawAnchor.getAttribute('href') || '').trim();
          if (rawHref.indexOf('#') === 0 && rawHref.length > 1 && rawHref.indexOf('#uncaptured-') !== 0) {
            try {
              var hashTarget = document.querySelector(rawHref);
              if (hashTarget) {
                ev.preventDefault();
                hashTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
              }
            } catch (err) {}
          }
          if (/^https?:\\/\\//i.test(rawHref) && !rawAnchor.hasAttribute('data-sg-route') && !rawAnchor.hasAttribute('data-sitegrab-uncaptured')) {
            // Prevent external navigation inside sandboxed iframe from blanking preview with X-Frame-Options error
            activeSnap = {
              control: rawAnchor,
              isBareHashLink: false,
              isExternalNavLink: rawHref,
              defaultPrevented: false,
              startScrollY: window.scrollY,
              startHash: window.location.hash,
              isMutated: function () { return false; },
              stop: function () {}
            };
            return;
          }
        }

        var control = ev.target.closest(
          'button, [role="button"], [role="tab"], [role="menuitem"], summary, a[href="#"], a[href^="javascript:"], a[data-sitegrab-uncaptured], a[data-sg-route], input[type="button"], .video-card, [data-video-id], [data-product-id], [data-post-id]'
        );
        if (!control) {
          var card = ev.target.closest('article, .card, [class*="card"]');
          if (card && !card.querySelector('a[href]:not([href="#"]):not([data-sitegrab-uncaptured])')) {
            control = card;
          }
        }
        if (!control) return;
        if (control.tagName === 'BUTTON' && (control.getAttribute('type') || 'submit').toLowerCase() === 'submit' && control.closest('form')) {
          return;
        }
        if (control.hasAttribute('onclick')) return;

        var meaningfulMutation = false;
        var observer = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
              for (var j = 0; j < m.addedNodes.length; j++) {
                var an = m.addedNodes[j];
                if (an && an.nodeType === 1 && !/toast/i.test(an.className || '')) {
                  meaningfulMutation = true;
                  return;
                }
              }
              if (m.removedNodes.length > 0) {
                meaningfulMutation = true;
                return;
              }
            } else if (m.type === 'attributes') {
              var attrName = m.attributeName || '';
              if (/^(hidden|aria-expanded|aria-selected|aria-pressed|aria-current|open|data-active|data-view|data-state)$/.test(attrName)) {
                meaningfulMutation = true;
                return;
              }
            }
          }
        });
        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true
        });
        activeSnap = {
          control: control,
          isBareHashLink:
            control.tagName === 'A' &&
            ((control.getAttribute('href') || '').trim() === '#' ||
              control.hasAttribute('data-sitegrab-uncaptured') ||
              control.hasAttribute('data-sg-route')),
          isExternalNavLink: null,
          defaultPrevented: false,
          startScrollY: window.scrollY,
          startHash: window.location.hash,
          isMutated: function () { return meaningfulMutation; },
          stop: function () { observer.disconnect(); }
        };
      },
      true
    );

    document.addEventListener('click', function (ev) {
      if (!activeSnap) return;
      var snap = activeSnap;
      activeSnap = null;
      if (snap.isExternalNavLink) {
        if (!ev.defaultPrevented) {
          ev.preventDefault();
          showToast('External link (' + snap.isExternalNavLink.replace(/^https?:\\/\\//i, '').slice(0, 44) + ') — kept inside interactive preview');
        }
        return;
      }
      if (ev.defaultPrevented) {
        snap.defaultPrevented = true;
      } else if (snap.isBareHashLink) {
        ev.preventDefault();
      }
      setTimeout(function () {
        snap.stop();
        var scrolled = !snap.isBareHashLink && window.scrollY !== snap.startScrollY;
        if (
          snap.defaultPrevented ||
          snap.isMutated() ||
          scrolled ||
          window.location.hash !== snap.startHash
        ) {
          return;
        }
        runFallbackClickAction(snap.control);
      }, 40);
    });

    // Live search / filter input fallback
    document.addEventListener('input', function (ev) {
      var input = ev.target;
      if (!input || input.tagName !== 'INPUT') return;
      var type = (input.getAttribute('type') || 'text').toLowerCase();
      var hint = (
        (input.getAttribute('placeholder') || '') +
        ' ' +
        (input.getAttribute('aria-label') || '') +
        ' ' +
        (input.getAttribute('name') || '')
      ).toLowerCase();
      if (type !== 'search' && !/search|filter|find|lookup|query/.test(hint)) return;

      var mutated = false;
      var obs = new MutationObserver(function () {
        mutated = true;
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });

      setTimeout(function () {
        obs.disconnect();
        if (mutated) return;
        var cards = findFilterContainer(input);
        if (!cards) return;
        var q = input.value.trim().toLowerCase();
        var visible = 0;
        cards.forEach(function (card) {
          var match = !q || (card.textContent || '').toLowerCase().indexOf(q) !== -1;
          card.classList.toggle('sg-runtime-hidden', !match);
          if (match) visible += 1;
        });
        if (q && visible === 0) {
          showToast('No items match "' + input.value.trim() + '"');
        }
      }, 45);
    });

    // Delegated form submit fallback so static AND dynamically mounted forms never reload the iframe
    document.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.dataset.sgHandled === 'true' || form.dataset.sgModalForm === 'true') return;
      if (ev.defaultPrevented) return;
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        return;
      }
      ev.preventDefault();
      var status = form.querySelector('.form-status, .sg-form-status, [role="status"]');
      if (!status) {
        status = document.createElement('p');
        status.className = 'sg-form-status';
        status.setAttribute('role', 'status');
        status.style.marginTop = '0.75rem';
        status.style.padding = '0.6rem 0.85rem';
        status.style.borderRadius = '8px';
        status.style.background = 'rgba(16, 185, 129, 0.14)';
        status.style.border = '1px solid rgba(16, 185, 129, 0.45)';
        status.style.color = 'inherit';
        status.style.fontSize = '0.9rem';
        form.appendChild(status);
      }
      status.textContent = 'Submitted! Your request has been processed in this interactive preview.';
      showToast('Submitted successfully.');
      form.reset();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapSiteGrabRuntime);
  } else {
    bootstrapSiteGrabRuntime();
  }
})();
`;

function relativeAssetPath(fromPageRel: string, targetRel: string): string {
  const fromDir = path.posix.dirname(fromPageRel);
  let rel = path.posix.relative(fromDir, targetRel);
  if (!rel) {
    rel = path.posix.basename(targetRel);
  } else if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return rel;
}

function resolveExistingFile(
  rawRef: string,
  sourcePageRel: string,
  fileMap: Map<string, string>,
): string | null {
  const trimmed = rawRef.trim();
  if (
    !trimmed ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('#')
  ) {
    return null;
  }

  const hashIdx = trimmed.indexOf('#');
  const hash = hashIdx >= 0 ? trimmed.slice(hashIdx) : '';
  const withoutHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const queryIdx = withoutHash.indexOf('?');
  const pathPart = (queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash).replace(/\\/g, '/');

  if (!pathPart) return null;
  if (pathPart === '/') {
    const idxTarget = fileMap.get('index.html');
    return idxTarget ? `${relativeAssetPath(sourcePageRel, idxTarget)}${hash}` : null;
  }

  const fromDir = path.posix.dirname(sourcePageRel);
  const candidateResolved = pathPart.startsWith('/')
    ? pathPart.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, pathPart));

  const trimmedPath = pathPart.replace(/^\.\//, '').replace(/^\/+/, '');
  const baseName = path.posix.basename(trimmedPath);
  const targetRel =
    fileMap.get(candidateResolved) ||
    fileMap.get(trimmedPath) ||
    fileMap.get(`${trimmedPath}.html`) ||
    fileMap.get(`pages/${trimmedPath}.html`) ||
    fileMap.get(baseName) ||
    fileMap.get(`${baseName}.html`);

  if (!targetRel) return null;
  return `${relativeAssetPath(sourcePageRel, targetRel)}${hash}`;
}

function buildSynthesizedSubpageHtml(options: {
  pageTitle: string;
  heading: string;
  siteTitle: string;
  indexHtml: string;
  primaryCssRel: string;
  primaryJsRel: string;
}): string {
  const { pageTitle, heading, siteTitle, indexHtml, primaryCssRel, primaryJsRel } = options;
  const $idx = cheerio.load(indexHtml);
  const headerHtml = $idx('header').first().prop('outerHTML') || '';
  const footerHtml = $idx('footer').first().prop('outerHTML') || '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeXml(pageTitle)} | ${escapeXml(siteTitle)}</title>
    <link rel="stylesheet" href="${escapeXml(primaryCssRel)}" />
  </head>
  <body>
    ${headerHtml}
    <main class="sg-container" style="padding-top: 3rem; padding-bottom: 4rem;">
      <section class="sg-card">
        <p style="margin: 0 0 0.5rem; font-size: 0.85rem; opacity: 0.75;">
          <a href="../index.html">&larr; Back to Home</a>
        </p>
        <h1 style="margin: 0 0 0.75rem; font-size: 2rem;">${escapeXml(heading)}</h1>
        <p style="margin: 0 0 1.5rem; opacity: 0.85;">
          Explore detailed information, interactive controls, and quick inquiries for ${escapeXml(heading)} at ${escapeXml(siteTitle)}.
        </p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.75rem;">
          <article class="sg-card">
            <h2 style="margin-top: 0; font-size: 1.1rem;">Key Highlights</h2>
            <p style="margin-bottom: 0; opacity: 0.8;">Designed for fast navigation, consistent styling, and responsive multi-device layout.</p>
          </article>
          <article class="sg-card">
            <h2 style="margin-top: 0; font-size: 1.1rem;">Interactive Workflows</h2>
            <p style="margin-bottom: 0; opacity: 0.8;">Use the form below or switch back to the main showcase at any time.</p>
          </article>
        </div>
        <form action="#" data-sitegrab-form="true" style="display: grid; gap: 0.85rem; max-width: 480px;">
          <label style="display: grid; gap: 0.35rem;">
            <span style="font-size: 0.9rem; font-weight: 600;">Email or Inquiry Note</span>
            <input type="text" required placeholder="Enter details or email..." style="padding: 0.65rem 0.85rem; border-radius: 8px; border: 1px solid rgba(148,163,184,0.35); background: rgba(15,23,42,0.45); color: inherit;" />
          </label>
          <div>
            <button type="submit" class="sg-btn">Submit Request</button>
          </div>
        </form>
      </section>
    </main>
    ${footerHtml}
    <script src="${escapeXml(primaryJsRel)}"></script>
  </body>
</html>`;
}

/**
 * Normalizes, validates, and repairs generated static project files so that:
 * - Every CSS/JS reference resolves cleanly across root and pages/*.html
 * - At least one working CSS file and JS runtime exist and are linked
 * - Missing/external <img> assets are replaced by clean local SVG graphics under assets/images/
 * - Internal <a href> links pointing to missing pages either jump to existing anchors or synthesize styled subpages
 */
export function normalizeAndRepairGeneratedFiles(
  rawFiles: Array<{ filePath?: string; content?: string }>,
  siteTitleFallback: string,
): GeneratedFileEntry[] {
  const entries: GeneratedFileEntry[] = [];
  const fileMap = new Map<string, string>();
  const seenDest = new Set<string>();

  for (const item of rawFiles) {
    if (!item || typeof item.filePath !== 'string' || typeof item.content !== 'string') continue;
    const rawClean = cleanRelInput(item.filePath);
    const cleanRel = normalizeGeneratedFilePath(item.filePath);
    if (!rawClean || !cleanRel || seenDest.has(cleanRel)) continue;
    seenDest.add(cleanRel);

    const ext = path.posix.extname(cleanRel).toLowerCase();
    entries.push({ cleanRel, ext, content: item.content });
    fileMap.set(rawClean, cleanRel);
    fileMap.set(cleanRel, cleanRel);
    fileMap.set(path.posix.basename(cleanRel), cleanRel);
  }

  // Ensure index.html exists
  if (!seenDest.has('index.html')) {
    entries.unshift({
      cleanRel: 'index.html',
      ext: '.html',
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeXml(siteTitleFallback)}</title>
    <link rel="stylesheet" href="./css/styles.css" />
  </head>
  <body>
    <main class="sg-container">
      <section class="sg-card">
        <h1>${escapeXml(siteTitleFallback)}</h1>
        <p>Interactive web experience ready for preview and export.</p>
      </section>
    </main>
    <script src="./js/main.js"></script>
  </body>
</html>`,
    });
    seenDest.add('index.html');
    fileMap.set('index.html', 'index.html');
  }

  // Ensure primary CSS file exists
  let primaryCss = entries.find((e) => e.ext === '.css')?.cleanRel;
  if (!primaryCss) {
    primaryCss = 'css/styles.css';
    entries.push({
      cleanRel: primaryCss,
      ext: '.css',
      content: DEFAULT_FALLBACK_CSS,
    });
    seenDest.add(primaryCss);
    fileMap.set(primaryCss, primaryCss);
    fileMap.set('styles.css', primaryCss);
  }

  // Ensure primary JS file exists
  let primaryJsEntry = entries.find((e) => e.ext === '.js' || e.ext === '.mjs');
  if (!primaryJsEntry) {
    primaryJsEntry = {
      cleanRel: 'js/main.js',
      ext: '.js',
      content: '/* SiteGrab primary script */\n',
    };
    entries.push(primaryJsEntry);
    seenDest.add(primaryJsEntry.cleanRel);
    fileMap.set(primaryJsEntry.cleanRel, primaryJsEntry.cleanRel);
    fileMap.set('main.js', primaryJsEntry.cleanRel);
  }
  const primaryJs = primaryJsEntry.cleanRel;

  // Always emit isolated SiteGrab runtime enhancer so page JS errors cannot disable button/auth/cart/player fallbacks
  const runtimeJsPath = 'js/sg-runtime.js';
  if (!seenDest.has(runtimeJsPath)) {
    entries.push({
      cleanRel: runtimeJsPath,
      ext: '.js',
      content: ENHANCED_INTERACTION_JS,
    });
    seenDest.add(runtimeJsPath);
    fileMap.set(runtimeJsPath, runtimeJsPath);
    fileMap.set('sg-runtime.js', runtimeJsPath);
  }

  // Inspect index.html IDs and data-view / data-tab selectors so missing subpage links switch views cleanly
  const indexEntry = entries.find((e) => e.cleanRel === 'index.html')!;
  const $idxScan = cheerio.load(indexEntry.content);
  const indexIds = new Set<string>();
  $idxScan('[id]').each((_, el) => {
    const id = $idxScan(el).attr('id');
    if (id) indexIds.add(id.toLowerCase());
  });
  const indexViews = new Set<string>();
  $idxScan('[data-view], [data-tab], [data-page]').each((_, el) => {
    const v =
      $idxScan(el).attr('data-view') ||
      $idxScan(el).attr('data-tab') ||
      $idxScan(el).attr('data-page');
    if (v) indexViews.add(v.trim().toLowerCase());
  });
  const siteTitle =
    $idxScan('title').first().text().trim() || siteTitleFallback || 'Website';

  let generatedSvgCount = 0;
  let synthesizedPagesCount = 0;
  const synthesizedPages: GeneratedFileEntry[] = [];

  const processHtmlEntry = (entry: GeneratedFileEntry, allowSynthesizeSubpage: boolean) => {
    const $ = cheerio.load(entry.content);

    // Ensure sandbox storage + history compatibility shim runs before any page script
    if ($('script[data-sitegrab-sandbox-shim]').length === 0) {
      if ($('head').length === 0) {
        $('html').prepend('<head></head>');
      }
      $('head').prepend(`\n    ${SANDBOX_COMPAT_HEAD_SHIM}`);
    }

    // Fix <form action="https://..."> so forms submit cleanly offline without broken cross-origin post
    $('form').each((_, el) => {
      const action = ($(el).attr('action') || '').trim();
      if (/^https?:\/\//i.test(action) || action.startsWith('//')) {
        $(el).attr('action', '#');
        $(el).attr('data-sitegrab-form', 'true');
      }
    });

    // Resolve or synthesize missing <img src>
    $('img').each((_, el) => {
      const rawSrc = ($(el).attr('src') || '').trim();
      if (!rawSrc || rawSrc.startsWith('data:') || rawSrc.startsWith('blob:')) return;

      const resolved = resolveExistingFile(rawSrc, entry.cleanRel, fileMap);
      if (resolved) {
        $(el).attr('src', resolved);
        return;
      }

      // Replace broken local path or external URL in generated output with crisp local SVG artwork
      const altText = ($(el).attr('alt') || '').trim();
      const baseSlug = slugifyName(
        altText || path.posix.basename(rawSrc.split(/[?#]/)[0] || ''),
        `graphic-${generatedSvgCount + 1}`,
      );
      let svgRel = `assets/images/${baseSlug}.svg`;
      while (seenDest.has(svgRel)) {
        generatedSvgCount += 1;
        svgRel = `assets/images/${baseSlug}-${generatedSvgCount}.svg`;
      }
      generatedSvgCount += 1;
      const svgContent = buildFallbackSvgGraphic(altText || siteTitle, generatedSvgCount);
      entries.push({
        cleanRel: svgRel,
        ext: '.svg',
        content: svgContent,
      });
      seenDest.add(svgRel);
      fileMap.set(svgRel, svgRel);
      fileMap.set(path.posix.basename(svgRel), svgRel);

      $(el).attr('src', relativeAssetPath(entry.cleanRel, svgRel));
    });

    // Ensure stylesheet links resolve cleanly
    let hasResolvedStylesheet = false;
    $('link[href]').each((_, el) => {
      const rawHref = ($(el).attr('href') || '').trim();
      const rel = ($(el).attr('rel') || '').toLowerCase();
      const resolved = resolveExistingFile(rawHref, entry.cleanRel, fileMap);
      if (resolved) {
        $(el).attr('href', resolved);
        if (rel.includes('stylesheet')) hasResolvedStylesheet = true;
      } else if (rel.includes('stylesheet') && !/^https?:\/\//i.test(rawHref) && !rawHref.startsWith('//')) {
        $(el).attr('href', relativeAssetPath(entry.cleanRel, primaryCss));
        hasResolvedStylesheet = true;
      }
    });
    if (!hasResolvedStylesheet) {
      $('head').append(
        `\n    <link rel="stylesheet" href="${relativeAssetPath(entry.cleanRel, primaryCss)}" />`,
      );
    }

    // Ensure script src resolves cleanly
    let hasResolvedScript = false;
    $('script[src]').each((_, el) => {
      const rawSrc = ($(el).attr('src') || '').trim();
      const resolved = resolveExistingFile(rawSrc, entry.cleanRel, fileMap);
      if (resolved) {
        $(el).attr('src', resolved);
        hasResolvedScript = true;
      } else if (!/^https?:\/\//i.test(rawSrc) && !rawSrc.startsWith('//')) {
        $(el).attr('src', relativeAssetPath(entry.cleanRel, primaryJs));
        hasResolvedScript = true;
      }
    });
    if (!hasResolvedScript) {
      $('body').append(
        `\n    <script src="${relativeAssetPath(entry.cleanRel, primaryJs)}"></script>`,
      );
    }
    const runtimeScriptRel = relativeAssetPath(entry.cleanRel, runtimeJsPath);
    if ($(`script[src="${runtimeScriptRel}"], script[src*="sg-runtime.js"]`).length === 0) {
      $('body').append(`\n    <script src="${runtimeScriptRel}"></script>`);
    }

    // Repair <a href> so internal navigation never lands on a broken 404
    $('a[href]').each((_, el) => {
      const rawHref = ($(el).attr('href') || '').trim();
      if (
        !rawHref ||
        rawHref.startsWith('#') ||
        rawHref.startsWith('http://') ||
        rawHref.startsWith('https://') ||
        rawHref.startsWith('//') ||
        rawHref.startsWith('mailto:') ||
        rawHref.startsWith('tel:') ||
        rawHref.startsWith('javascript:')
      ) {
        return;
      }

      const resolved = resolveExistingFile(rawHref, entry.cleanRel, fileMap);
      if (resolved) {
        $(el).attr('href', resolved);
        return;
      }

      const withoutQuery = rawHref.split('#')[0].split('?')[0];
      const slug = slugifyName(path.posix.basename(withoutQuery, path.posix.extname(withoutQuery)), '');
      if (slug && indexIds.has(slug)) {
        const prefix = entry.cleanRel === 'index.html' ? '' : relativeAssetPath(entry.cleanRel, 'index.html');
        $(el).attr('href', `${prefix}#${slug}`);
        return;
      }
      if (slug && indexViews.has(slug)) {
        $(el).attr('href', '#');
        $(el).attr('data-sg-route', slug);
        return;
      }
      if (
        slug &&
        /^(login|signin|sign-in|signup|sign-up|register|auth|account|profile|watch|video|shorts|cart|bag|checkout|upload|create|compose|search|notifications|settings|subscriptions|library|trending|explore|history|liked)$/.test(
          slug,
        )
      ) {
        $(el).attr('href', '#');
        $(el).attr('data-sg-route', `/${slug}`);
        return;
      }

      if (allowSynthesizeSubpage && slug && synthesizedPagesCount < 5) {
        const subRel = `pages/${slug}.html`;
        if (!seenDest.has(subRel)) {
          synthesizedPagesCount += 1;
          seenDest.add(subRel);
          fileMap.set(subRel, subRel);
          fileMap.set(`${slug}.html`, subRel);
          fileMap.set(rawHref.replace(/^\/+/, ''), subRel);

          const linkLabel = $(el).text().trim() || slug.replace(/-/g, ' ');
          const prettyHeading = linkLabel.replace(/\b\w/g, (ch) => ch.toUpperCase());
          const subHtml = buildSynthesizedSubpageHtml({
            pageTitle: prettyHeading,
            heading: prettyHeading,
            siteTitle,
            indexHtml: indexEntry.content,
            primaryCssRel: relativeAssetPath(subRel, primaryCss),
            primaryJsRel: relativeAssetPath(subRel, primaryJs),
          });
          synthesizedPages.push({
            cleanRel: subRel,
            ext: '.html',
            content: subHtml,
          });
        }
        $(el).attr('href', relativeAssetPath(entry.cleanRel, subRel));
        return;
      }

      // Fallback cleanly to interactive route or index.html so clicking never breaks
      $(el).attr('href', '#');
      if (slug) {
        $(el).attr('data-sg-route', `/${slug}`);
      }
    });

    entry.content = $.html();
  };

  for (const entry of entries) {
    if (entry.ext === '.html' || entry.ext === '.htm') {
      processHtmlEntry(entry, true);
    }
  }

  // Normalize synthesized subpage links without cascading further subpages
  for (const subEntry of synthesizedPages) {
    processHtmlEntry(subEntry, false);
    entries.push(subEntry);
  }

  return entries;
}
