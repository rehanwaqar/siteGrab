import { useRef, useState, type ChangeEvent } from 'react';
import {
  FileArchive,
  HelpCircle,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Upload,
  Wrench,
} from 'lucide-react';
import type { WaitStrategy } from '../types';
import { getFriendlyErrorTitle } from '../utils/format';

export interface RecoveryRetrySettings {
  timeoutMs: number;
  waitStrategy: WaitStrategy;
}

interface FailureRecoveryPanelProps {
  errorCode?: string;
  errorMessage: string;
  targetUrl: string;
  onRetryCapture: (recoverySettings: RecoveryRetrySettings) => void;
  onUploadZip: (file: File) => Promise<void>;
  onUploadScreenshot: (file: File, notes?: string) => Promise<void>;
  onFocusUrlInput: () => void;
  onDismiss: () => void;
}

type RecoveryTab = 'retry' | 'upload' | 'screenshot' | 'troubleshoot';

interface GuidanceSpec {
  defaultTab: RecoveryTab;
  summary: string;
  steps: string[];
  allowRetry: boolean;
}

function getGuidanceForError(errorCode?: string): GuidanceSpec {
  switch (errorCode) {
    case 'MISSING_CHROMIUM':
      return {
        defaultTab: 'troubleshoot',
        summary:
          'The backend server cannot find or launch headless Chromium, so URL rendering is unavailable until the browser binary is installed.',
        steps: [
          'Ask the server administrator or run "npx playwright install chromium" on the host environment (plus system dependencies in Docker).',
          'If you already exported a project ZIP from Bolt, Lovable, or your repository, use the Upload Website ZIP tab right now without needing Chromium.',
        ],
        allowRetry: true,
      };
    case 'TIMEOUT':
      return {
        defaultTab: 'retry',
        summary:
          'The page kept network connections active or took longer than the capture timeout to finish rendering.',
        steps: [
          'Use Retry Capture with a longer timeout (120s) and switch the loading strategy to "DOM Content Loaded" or "Window Load" so background analytics/WebSockets do not stall capture.',
          'Alternatively, export your project ZIP from your builder and upload it directly in the Upload Website ZIP tab.',
        ],
        allowRetry: true,
      };
    case 'ACCESS_DENIED':
      return {
        defaultTab: 'upload',
        summary:
          'The target server, firewall, or CDN returned HTTP 401/403 and blocked automated requests. SiteGrab does not bypass authentication, CAPTCHAs, or security controls.',
        steps: [
          'If you own or administer this website, export its built files or source archive directly from your host or builder and import it using Upload Website ZIP.',
          'Otherwise, temporarily allow public access to the page you own before retrying capture.',
        ],
        allowRetry: true,
      };
    case 'PRIVATE_SITE':
      return {
        defaultTab: 'upload',
        summary:
          'This URL points to a private workspace preview or login-protected page that cannot be accessed anonymously by an external server.',
        steps: [
          'Publish or deploy the project to a public URL in Bolt, Lovable, StackBlitz, or your hosting provider, then retry with the published URL.',
          'Or download/export the project ZIP directly from your builder and upload it here using Upload Website ZIP.',
        ],
        allowRetry: true,
      };
    case 'ROBOTS_DISALLOWED':
      return {
        defaultTab: 'upload',
        summary:
          'The website’s robots.txt policy restricts automated crawling on this path, and SiteGrab strictly honors robots.txt.',
        steps: [
          'If you own this site, update robots.txt to permit access for your path before retrying.',
          'Or export an authorized project ZIP and import it in the Upload Website ZIP tab.',
        ],
        allowRetry: true,
      };
    case 'INVALID_URL':
    case 'INVALID_SCHEME':
      return {
        defaultTab: 'troubleshoot',
        summary:
          'The URL provided is malformed or uses an unsupported scheme.',
        steps: [
          'Correct the URL in the input box above using a full public http:// or https:// address (for example: https://example.com).',
          'If you only have local files on your computer, compress them into a .zip archive and use Upload Website ZIP.',
        ],
        allowRetry: false,
      };
    case 'BLOCKED_ADDRESS':
      return {
        defaultTab: 'upload',
        summary:
          'Localhost, private IP ranges, and internal network hosts are blocked for security.',
        steps: [
          'Deploy the site to a public https:// URL first, or compress your local project folder into a .zip file and import it via Upload Website ZIP.',
        ],
        allowRetry: false,
      };
    case 'DNS_ERROR':
    case 'NETWORK_ERROR':
      return {
        defaultTab: 'retry',
        summary:
          'SiteGrab could not establish a network connection or resolve the domain name for this URL.',
        steps: [
          'Check for domain typos, confirm the deployed URL loads publicly in your browser, and check HTTPS certificate validity.',
          'Retry the capture once the host is reachable, or import a project ZIP export directly.',
        ],
        allowRetry: true,
      };
    case 'RATE_LIMITED':
      return {
        defaultTab: 'upload',
        summary:
          'You have reached the temporary capture rate limit (5 URL captures per 10 minutes).',
        steps: [
          'Wait for the cooldown period shown above before starting another URL capture.',
          'If you already have an exported website ZIP, you can still upload and process it immediately via Upload Website ZIP.',
        ],
        allowRetry: true,
      };
    default:
      return {
        defaultTab: 'retry',
        summary:
          'The target website could not be captured with default browser settings.',
        steps: [
          'Try retrying with a 120-second timeout and an adjusted page-loading strategy.',
          'If the host blocks automated browsers or runs behind a private preview, export a ZIP from your builder and import it in Upload Website ZIP.',
        ],
        allowRetry: true,
      };
  }
}

export function FailureRecoveryPanel({
  errorCode,
  errorMessage,
  targetUrl,
  onRetryCapture,
  onUploadZip,
  onUploadScreenshot,
  onFocusUrlInput,
  onDismiss,
}: FailureRecoveryPanelProps) {
  const guidance = getGuidanceForError(errorCode);
  const [activeTab, setActiveTab] = useState<RecoveryTab>(guidance.defaultTab);
  const [timeoutMs, setTimeoutMs] = useState<number>(120_000);
  const [waitStrategy, setWaitStrategy] = useState<WaitStrategy>(
    errorCode === 'TIMEOUT' ? 'domcontentloaded' : 'load',
  );
  const [isUploadingZip, setIsUploadingZip] = useState(false);
  const [zipUploadError, setZipUploadError] = useState<string | null>(null);
  const [isGeneratingShot, setIsGeneratingShot] = useState(false);
  const [shotNotes, setShotNotes] = useState('');
  const [shotError, setShotError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shotInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      setZipUploadError('Please select a valid .zip archive.');
      return;
    }

    setZipUploadError(null);
    setIsUploadingZip(true);
    try {
      await onUploadZip(file);
    } catch (err) {
      setZipUploadError(err instanceof Error ? err.message : 'Could not process the uploaded ZIP.');
    } finally {
      setIsUploadingZip(false);
    }
  };

  const handleScreenshotChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name) && !file.type.startsWith('image/')) {
      setShotError('Please select a PNG, JPEG, WebP, or GIF screenshot.');
      return;
    }

    setShotError(null);
    setIsGeneratingShot(true);
    try {
      await onUploadScreenshot(file, shotNotes);
    } catch (err) {
      setShotError(
        err instanceof Error ? err.message : 'Could not generate website from screenshot.',
      );
    } finally {
      setIsGeneratingShot(false);
    }
  };

  return (
    <section
      role="alert"
      aria-label="Capture failure recovery"
      className="rounded-xl border border-red-200 dark:border-red-900/60 bg-white dark:bg-[#111827] overflow-hidden"
    >
      {/* Failure Reason Header */}
      <div className="border-b border-red-200/80 dark:border-red-900/50 bg-red-50/80 dark:bg-red-950/30 p-5">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <ShieldAlert className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
                  {getFriendlyErrorTitle(errorCode)}
                </h2>
                {errorCode && (
                  <span className="font-mono text-[11px] text-red-700/80 dark:text-red-300/80">
                    ({errorCode})
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-red-800 dark:text-red-300 leading-relaxed">
                {errorMessage}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            className="self-start rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors cursor-pointer shrink-0"
          >
            Dismiss
          </button>
        </div>

        {/* Recovery Mode Tabs */}
        <div
          role="tablist"
          aria-label="Recovery options"
          className="mt-4 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B0F17] p-1 w-fit"
        >
          {guidance.allowRetry && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'retry'}
              onClick={() => setActiveTab('retry')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                activeTab === 'retry'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Retry Capture</span>
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'upload'}
            onClick={() => setActiveTab('upload')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'upload'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <FileArchive className="h-3.5 w-3.5" />
            <span>Upload Website ZIP</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'screenshot'}
            onClick={() => setActiveTab('screenshot')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'screenshot'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" />
            <span>Upload Screenshot</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'troubleshoot'}
            onClick={() => setActiveTab('troubleshoot')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
              activeTab === 'troubleshoot'
                ? 'bg-sky-600 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <HelpCircle className="h-3.5 w-3.5" />
            <span>Troubleshooting</span>
          </button>
        </div>
      </div>

      {/* Recovery Panel Body */}
      <div className="p-5 sm:p-6 bg-slate-50/50 dark:bg-[#0B0F17]/60">
        {activeTab === 'retry' && guidance.allowRetry && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Retry with Adjusted Timeout & Loading Strategy
                </h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Retrying <code className="font-mono">{targetUrl || 'target URL'}</code> while keeping your selected Capture Options.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="block rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-3.5">
                <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Capture Timeout
                </span>
                <select
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(Number(e.target.value))}
                  className="mt-2 h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2.5 text-xs font-mono text-slate-900 dark:text-slate-100"
                >
                  <option value={60_000}>60 seconds (Standard)</option>
                  <option value={90_000}>90 seconds (Extended)</option>
                  <option value={120_000}>120 seconds (Maximum)</option>
                </select>
              </label>

              <label className="block rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-3.5">
                <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Page-Loading Strategy
                </span>
                <select
                  value={waitStrategy}
                  onChange={(e) => setWaitStrategy(e.target.value as WaitStrategy)}
                  className="mt-2 h-9 w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2.5 text-xs font-mono text-slate-900 dark:text-slate-100"
                >
                  <option value="domcontentloaded">DOM Content Loaded (Fastest for SPAs)</option>
                  <option value="load">Window Load (Ignores background polling)</option>
                  <option value="networkidle">Network Idle (Wait for all requests)</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => onRetryCapture({ timeoutMs, waitStrategy })}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Retry Capture Now</span>
              </button>
              <button
                type="button"
                onClick={onFocusUrlInput}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <span>Edit URL</span>
              </button>
            </div>
          </div>
        )}

        {activeTab === 'upload' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Import Website Project ZIP
              </h3>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Upload a <code className="font-mono">.zip</code> exported from Bolt, Lovable, GitHub, or any static site builder. SiteGrab validates the archive, preserves its folder structure, formats HTML/CSS/JS if enabled, and opens it in Preview, File Inspector, AI Assistant, and VS Code ZIP export.
              </p>
            </div>

            <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] p-6 text-center space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip,application/x-zip-compressed"
                onChange={(e) => void handleFileChange(e)}
                className="hidden"
                aria-label="Upload website ZIP file"
              />
              <FileArchive className="mx-auto h-7 w-7 text-sky-500" />
              <div className="text-xs text-slate-600 dark:text-slate-400">
                Max 50 MB upload · Up to 500 files / 100 MB extracted · Unsafe paths blocked automatically
              </div>
              <button
                type="button"
                disabled={isUploadingZip}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                {isUploadingZip ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                <span>{isUploadingZip ? 'Extracting & Processing ZIP...' : 'Choose Website .zip File'}</span>
              </button>
            </div>

            {zipUploadError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
              >
                {zipUploadError}
              </div>
            )}
          </div>
        )}

        {activeTab === 'screenshot' && (
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                No ZIP? Generate Website from a Screenshot
              </h3>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Upload a screenshot (PNG, JPEG, WebP, or GIF) of your site or UI design. SiteGrab recreates the layout in responsive HTML, CSS, and JavaScript, opens it in Preview &amp; File Inspector, and packages a ready-to-run VS Code ZIP.
              </p>
            </div>

            <input
              type="text"
              value={shotNotes}
              onChange={(e) => setShotNotes(e.target.value)}
              disabled={isGeneratingShot}
              placeholder="Optional notes (e.g., Keep exact dark theme, include interactive pricing toggle)"
              aria-label="Optional screenshot instructions"
              className="h-10 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] px-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
            />

            <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] p-6 text-center space-y-3">
              <input
                ref={shotInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => void handleScreenshotChange(e)}
                className="hidden"
                aria-label="Upload screenshot image"
              />
              <ImageIcon className="mx-auto h-7 w-7 text-sky-500" />
              <div className="text-xs text-slate-600 dark:text-slate-400">
                Supports PNG, JPEG, WebP, GIF · Max 10 MB · Generates index.html, CSS &amp; JS
              </div>
              <button
                type="button"
                disabled={isGeneratingShot}
                onClick={() => shotInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                {isGeneratingShot ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                <span>
                  {isGeneratingShot
                    ? 'Generating Website from Screenshot...'
                    : 'Choose Screenshot Image'}
                </span>
              </button>
            </div>

            {shotError && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
              >
                {shotError}
              </div>
            )}
          </div>
        )}

        {activeTab === 'troubleshoot' && (
          <div className="space-y-4">
            <div className="flex items-start gap-2.5">
              <Wrench className="h-4 w-4 text-sky-500 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Why this capture failed & how to resolve it
                </h3>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  {guidance.summary}
                </p>
              </div>
            </div>

            <ol className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 list-decimal pl-8 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              {guidance.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center gap-2.5">
              {(errorCode === 'INVALID_URL' || errorCode === 'INVALID_SCHEME' || errorCode === 'DNS_ERROR') && (
                <button
                  type="button"
                  onClick={onFocusUrlInput}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3.5 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
                >
                  <span>Fix URL Above</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveTab('upload')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <FileArchive className="h-3.5 w-3.5" />
                <span>Switch to ZIP Upload</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
