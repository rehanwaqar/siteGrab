import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Download,
  Globe,
  Moon,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { HistoryView } from './components/HistoryView';
import { PreviewPanel } from './components/PreviewPanel';
import { ProgressPanel } from './components/ProgressPanel';
import { TermsView } from './components/TermsView';
import type { ActiveView, HistoryEntry, ProgressEvent } from './types';
import { formatBytes, formatRelativeTime, getFriendlyErrorTitle } from './utils/format';

const HISTORY_STORAGE_KEY = 'sitegrab_history_v1';
const THEME_STORAGE_KEY = 'sitegrab_theme_v1';

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light') return false;
      return true;
    } catch {
      return true;
    }
  });

  const [activeView, setActiveView] = useState<ActiveView>('capture');
  const [urlInput, setUrlInput] = useState('');
  const [crawlDepth, setCrawlDepth] = useState<number>(0);
  const [maxPages, setMaxPages] = useState<number>(5);
  const [formatCode, setFormatCode] = useState<boolean>(true);
  const [recoverSourceMaps, setRecoverSourceMaps] = useState<boolean>(true);

  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeHostname, setActiveHostname] = useState<string>('');
  const [siteTitle, setSiteTitle] = useState<string>('');
  const [zipFilename, setZipFilename] = useState<string>('');
  const [progressEvent, setProgressEvent] = useState<ProgressEvent | null>(null);
  const [errorState, setErrorState] = useState<{ code?: string; message: string } | null>(null);
  const [downloaded, setDownloaded] = useState<boolean>(false);

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, darkMode ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [darkMode]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 15)));
    } catch {
      // Ignore storage errors
    }
  }, [history]);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const closeActiveStream = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const recordHistoryEntry = async (jobId: string, event: ProgressEvent, targetUrl: string, host: string) => {
    let resolvedTitle = host;
    let resolvedZip = `sitegrab-${host}.zip`;
    try {
      const statusRes = await fetch(`/api/capture/${encodeURIComponent(jobId)}/status`);
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as {
          siteTitle?: string;
          zipFilename?: string;
        };
        if (statusData.siteTitle) resolvedTitle = statusData.siteTitle;
        if (statusData.zipFilename) resolvedZip = statusData.zipFilename;
      }
    } catch {
      // Fall back to hostname
    }

    setSiteTitle(resolvedTitle);
    setZipFilename(resolvedZip);

    const newEntry: HistoryEntry = {
      id: jobId,
      url: targetUrl,
      hostname: host,
      siteTitle: resolvedTitle,
      zipFilename: resolvedZip,
      capturedAt: Date.now(),
      stats: event.stats,
      options: {
        crawlDepth,
        maxPages,
        formatCode,
        recoverSourceMaps,
      },
    };

    setHistory((prev) => [newEntry, ...prev.filter((item) => item.id !== jobId)].slice(0, 15));
  };

  const handleStartCapture = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) {
      setErrorState({ code: 'INVALID_URL', message: 'Please enter a valid http:// or https:// URL.' });
      return;
    }

    // Auto-prepend https:// only if user omitted scheme, while validating clearly
    const normalizedInput = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;

    closeActiveStream();
    setErrorState(null);
    setProgressEvent(null);
    setActiveJobId(null);
    setDownloaded(false);
    setIsCapturing(true);

    try {
      const response = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: normalizedInput,
          crawlDepth,
          maxPages: crawlDepth > 0 ? maxPages : 1,
          formatCode,
          recoverSourceMaps,
        }),
      });

      const data = (await response.json()) as {
        jobId?: string;
        url?: string;
        hostname?: string;
        error?: string;
        errorCode?: string;
      };

      if (!response.ok || !data.jobId) {
        setIsCapturing(false);
        setErrorState({
          code: data.errorCode || (response.status === 429 ? 'RATE_LIMITED' : 'CAPTURE_FAILED'),
          message: data.error || 'Could not start capture job.',
        });
        return;
      }

      const jobId = data.jobId;
      const host = data.hostname || '';
      const resolvedUrl = data.url || normalizedInput;
      setUrlInput(resolvedUrl);
      setActiveJobId(jobId);
      setActiveHostname(host);
      setSiteTitle(host);
      setZipFilename(`sitegrab-${host}.zip`);

      const es = new EventSource(`/api/capture/${encodeURIComponent(jobId)}/events`);
      eventSourceRef.current = es;

      es.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data) as ProgressEvent;
          setProgressEvent(evt);

          if (evt.stage === 'ready') {
            es.close();
            eventSourceRef.current = null;
            setIsCapturing(false);
            void recordHistoryEntry(jobId, evt, resolvedUrl, host);
          } else if (evt.stage === 'error') {
            es.close();
            eventSourceRef.current = null;
            setIsCapturing(false);
            setErrorState({
              code: evt.errorCode,
              message: evt.message,
            });
          }
        } catch {
          // Ignore malformed event
        }
      };

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) return;
        es.close();
        eventSourceRef.current = null;
        setIsCapturing(false);
        setErrorState((prev) =>
          prev ?? {
            code: 'CONNECTION_LOST',
            message: 'Lost live progress connection. Check the URL and try again.',
          },
        );
      };
    } catch {
      setIsCapturing(false);
      setErrorState({
        code: 'NETWORK_ERROR',
        message: 'Could not reach the SiteGrab server. Please try again.',
      });
    }
  };

  const handleDownloadZip = () => {
    if (!activeJobId || downloaded) return;
    const link = document.createElement('a');
    link.href = `/api/capture/${encodeURIComponent(activeJobId)}/download`;
    link.download = zipFilename || 'sitegrab-archive.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setDownloaded(true);
  };

  const handleLoadFromHistory = (entry: HistoryEntry) => {
    setUrlInput(entry.url);
    setCrawlDepth(entry.options.crawlDepth);
    setMaxPages(entry.options.maxPages);
    setFormatCode(entry.options.formatCode);
    setRecoverSourceMaps(entry.options.recoverSourceMaps);
    setErrorState(null);
    setActiveView('capture');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      {/* Three-Zone Top Bar */}
      <header className="border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-[#0B0F17]/90 backdrop-blur-sm sticky top-0 z-20">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 py-3.5">
          {/* Zone 1: Brand wordmark */}
          <button
            type="button"
            onClick={() => setActiveView('capture')}
            className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            SiteGrab
          </button>

          {/* Zone 2: Concise single-line navigation links */}
          <nav aria-label="Primary navigation" className="flex items-center gap-6 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveView('capture')}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                activeView === 'capture'
                  ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Capture
            </button>
            <button
              type="button"
              onClick={() => setActiveView('history')}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                activeView === 'history'
                  ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              History{history.length > 0 ? ` (${history.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setActiveView('terms')}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                activeView === 'terms'
                  ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Terms
            </button>
          </nav>

          {/* Zone 3: Single primary action (Theme Switch) */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setDarkMode((prev) => !prev)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              <span>{darkMode ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 sm:px-6 py-10 sm:py-14">
        {activeView === 'history' && (
          <HistoryView
            history={history}
            onRecapture={handleLoadFromHistory}
            onClearHistory={() => setHistory([])}
            onSwitchToCapture={() => setActiveView('capture')}
          />
        )}

        {activeView === 'terms' && (
          <TermsView onBackToCapture={() => setActiveView('capture')} />
        )}

        {activeView === 'capture' && (
          <div className="mx-auto max-w-4xl space-y-8">
            {/* Hero & Centered URL Input */}
            <section className="text-center">
              <h1
                style={{ textWrap: 'balance' }}
                className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-100"
              >
                Download any site you own as an offline VS Code project
              </h1>
              <p className="mx-auto mt-3 max-w-2xl text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
                Renders with headless Chromium, rewrites asset URLs to local relative paths, formats HTML/CSS/JS with Prettier, and recovers published source maps.
              </p>

              {/* URL Form */}
              <form onSubmit={handleStartCapture} className="mx-auto mt-7 max-w-2xl">
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="relative flex-1">
                    <Globe className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      type="text"
                      inputMode="url"
                      aria-label="Website URL"
                      placeholder="https://example.com"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      disabled={isCapturing}
                      className="h-12 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] pl-10 pr-4 text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20 disabled:opacity-60"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isCapturing}
                    className="h-12 inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-sky-600/60 px-6 text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                  >
                    <Download className="h-4 w-4 shrink-0" />
                    <span>{isCapturing ? 'Capturing...' : 'Download'}</span>
                  </button>
                </div>

                {/* Permission Notice */}
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Only use this on sites you own or have permission to copy.{' '}
                    <button
                      type="button"
                      onClick={() => setActiveView('terms')}
                      className="underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300 cursor-pointer"
                    >
                      Read Terms
                    </button>
                  </span>
                </p>
              </form>
            </section>

            {/* Capture Options Panel */}
            <section
              aria-label="Capture options"
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <SlidersHorizontal className="h-4 w-4 text-slate-400" />
                  <span>Capture Options</span>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  Respects robots.txt · Max 100 MB · Max 500 files · 60s timeout
                </span>
              </div>

              <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Crawl Depth + Max Pages */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      Multi-Page Crawl Depth
                    </label>
                    {crawlDepth > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                        <span>Max pages:</span>
                        <select
                          value={maxPages}
                          onChange={(e) => setMaxPages(Number(e.target.value))}
                          disabled={isCapturing}
                          className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2 py-0.5 text-xs font-mono text-slate-900 dark:text-slate-100"
                        >
                          <option value={3}>3</option>
                          <option value={5}>5</option>
                          <option value={10}>10</option>
                          <option value={15}>15</option>
                          <option value={25}>25</option>
                        </select>
                      </label>
                    )}
                  </div>

                  <div
                    role="group"
                    aria-label="Crawl depth"
                    className="grid grid-cols-4 gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-1"
                  >
                    {[
                      { value: 0, label: 'Single' },
                      { value: 1, label: 'Depth 1' },
                      { value: 2, label: 'Depth 2' },
                      { value: 3, label: 'Depth 3' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={isCapturing}
                        onClick={() => setCrawlDepth(opt.value)}
                        className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                          crawlDepth === opt.value
                            ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Format Code Toggle */}
                <label className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 cursor-pointer">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      Format Code
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Run Prettier on HTML, CSS, and JS files.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={formatCode}
                    disabled={isCapturing}
                    onChange={(e) => setFormatCode(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                {/* Recover Source Maps Toggle */}
                <label className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 cursor-pointer">
                  <div>
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      Recover Source Maps
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Rebuild <code className="font-mono">/recovered-src</code> from published <code className="font-mono">.map</code> files.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={recoverSourceMaps}
                    disabled={isCapturing}
                    onChange={(e) => setRecoverSourceMaps(e.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>
              </div>
            </section>

            {/* Friendly Error Banner */}
            {errorState && (
              <section
                role="alert"
                className="rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/80 dark:bg-red-950/30 p-5"
              >
                <div className="flex items-start gap-3">
                  <ShieldAlert className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
                      {getFriendlyErrorTitle(errorState.code)}
                    </h2>
                    <p className="mt-1 text-sm text-red-700 dark:text-red-300">
                      {errorState.message}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setErrorState(null)}
                    className="rounded-lg px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors cursor-pointer"
                  >
                    Dismiss
                  </button>
                </div>
              </section>
            )}

            {/* Live SSE Progress Bar */}
            {progressEvent && progressEvent.stage !== 'error' && (
              <ProgressPanel event={progressEvent} targetHostname={activeHostname} />
            )}

            {/* Live Preview & Download Panel */}
            {progressEvent?.stage === 'ready' && activeJobId && (
              <PreviewPanel
                jobId={activeJobId}
                siteTitle={siteTitle}
                hostname={activeHostname}
                zipFilename={zipFilename}
                event={progressEvent}
                downloaded={downloaded}
                onDownload={handleDownloadZip}
              />
            )}

            {/* Compact Recent Downloads Strip */}
            {history.length > 0 && (
              <section className="pt-2">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Recent Snapshots
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveView('history')}
                    className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    View all ({history.length})
                  </button>
                </div>
                <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                  {history.slice(0, 3).map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {entry.siteTitle || entry.hostname}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          <span>{formatRelativeTime(entry.capturedAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.stats.pagesCaptured}p</span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.stats.assetsCaptured} assets</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatBytes(entry.stats.zipBytes ?? entry.stats.totalBytes)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleLoadFromHistory(entry)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="h-3 w-3" />
                        <span>Reuse</span>
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </main>

      {/* Clean Minimal Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 px-4 sm:px-6 py-5">
        <div className="mx-auto flex max-w-6xl flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>SiteGrab — Only use on websites you own or have permission to copy.</span>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveView('terms')}
              className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              Terms of Use
            </button>
            <button
              type="button"
              onClick={() => setActiveView('history')}
              className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              Download History
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
