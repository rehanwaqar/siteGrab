import { AlertCircle, Download, Eye, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import type {
  CapturedFileEntry,
  CaptureStats,
  DiagnosticReport,
  HistoryEntry,
  ProgressEvent,
} from '../types';
import { formatBytes, formatDurationMs, formatRelativeTime } from '../utils/format';
import { PreviewPanel } from './PreviewPanel';

export interface HistoryPreviewWorkspace {
  entryId: string;
  jobId: string;
  previewToken: string | null;
  siteTitle: string;
  hostname: string;
  zipFilename: string;
  event: ProgressEvent;
  files: CapturedFileEntry[];
  diagnostics: DiagnosticReport;
  hasOriginalScreenshot: boolean;
}

interface HistoryViewProps {
  history: HistoryEntry[];
  activePreview: HistoryPreviewWorkspace | null;
  loadingPreviewId: string | null;
  previewUnavailableEntry: HistoryEntry | null;
  previewError: string | null;
  isDownloading: boolean;
  downloadPercent: number | null;
  downloadComplete: boolean;
  downloadError: string | null;
  onPreviewHistoryEntry: (entry: HistoryEntry) => void;
  onClosePreview: () => void;
  onRecapture: (entry: HistoryEntry, autoRun?: boolean) => void;
  onDownloadHistoryEntry: (entry: HistoryEntry) => void;
  onDownloadActivePreview: (jobId: string, zipFilename: string) => void;
  onWorkspaceUpdated: (
    jobId: string,
    payload: {
      files: CapturedFileEntry[];
      stats: CaptureStats;
      appliedFiles: string[];
    },
  ) => void;
  onClearHistory: () => void;
  onSwitchToCapture: () => void;
}

export function HistoryView({
  history,
  activePreview,
  loadingPreviewId,
  previewUnavailableEntry,
  previewError,
  isDownloading,
  downloadPercent,
  downloadComplete,
  downloadError,
  onPreviewHistoryEntry,
  onClosePreview,
  onRecapture,
  onDownloadHistoryEntry,
  onDownloadActivePreview,
  onWorkspaceUpdated,
  onClearHistory,
  onSwitchToCapture,
}: HistoryViewProps) {
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Project History
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Saved privately to your signed-in account. Preview generated files, inspect source code, recapture, or download ZIPs.
          </p>
        </div>

        {history.length > 0 && (
          <button
            type="button"
            onClick={onClearHistory}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Clear History</span>
          </button>
        )}
      </div>

      {/* Inline Preview Drawer for Selected History Item */}
      {activePreview && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-sky-200 dark:border-sky-900/60 bg-sky-50/70 dark:bg-sky-950/20 px-4 py-2.5">
            <div className="flex items-center gap-2 text-xs font-medium text-sky-900 dark:text-sky-200 min-w-0">
              <Eye className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
              <span className="truncate">
                Previewing saved project: <strong>{activePreview.siteTitle || activePreview.hostname}</strong>
              </span>
            </div>
            <button
              type="button"
              onClick={onClosePreview}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
              <span>Close Preview</span>
            </button>
          </div>

          <PreviewPanel
            key={activePreview.jobId}
            jobId={activePreview.jobId}
            previewToken={activePreview.previewToken}
            siteTitle={activePreview.siteTitle}
            hostname={activePreview.hostname}
            zipFilename={activePreview.zipFilename}
            event={activePreview.event}
            files={activePreview.files}
            diagnostics={activePreview.diagnostics}
            hasOriginalScreenshot={activePreview.hasOriginalScreenshot}
            isDownloading={isDownloading}
            downloadPercent={downloadPercent}
            downloadComplete={downloadComplete}
            downloadError={downloadError}
            onDownload={() =>
              onDownloadActivePreview(activePreview.jobId, activePreview.zipFilename)
            }
            onRecapture={() => {
              const target = history.find((item) => item.id === activePreview.entryId);
              if (target) {
                onRecapture(target, true);
              }
            }}
            onWorkspaceUpdated={(payload) =>
              onWorkspaceUpdated(activePreview.jobId, payload)
            }
          />
        </div>
      )}

      {!activePreview && previewUnavailableEntry && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-2.5 text-xs text-amber-900 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-semibold">
                {previewError ||
                  `Temporary files for ${previewUnavailableEntry.siteTitle || previewUnavailableEntry.hostname} were not saved to cloud preview yet.`}
              </p>
              <p className="mt-0.5 opacity-85">
                {previewUnavailableEntry.url.startsWith('http')
                  ? 'Click Regenerate & Preview to rebuild its files cleanly and save a persistent preview.'
                  : 'Re-upload your screenshot or ZIP file in Capture Studio to preview and save its workspace.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {previewUnavailableEntry.url.startsWith('http') ? (
              <button
                type="button"
                onClick={() => onRecapture(previewUnavailableEntry, true)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Regenerate &amp; Preview</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSwitchToCapture}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors cursor-pointer"
              >
                <span>Open Capture Studio</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClosePreview}
              aria-label="Dismiss preview notice"
              className="rounded-lg border border-amber-300 dark:border-amber-800 px-2.5 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100/60 dark:hover:bg-amber-900/30 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {history.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-6 py-12 text-center">
          <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
            No captured projects yet
          </h2>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            Completed site snapshots will appear here with instant preview, file counts, durations, and saved options.
          </p>
          <button
            type="button"
            onClick={onSwitchToCapture}
            className="mt-5 inline-flex items-center rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            Capture a Website
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] divide-y divide-slate-200 dark:divide-slate-800">
          {history.map((entry) => {
            const isActive = activePreview?.entryId === entry.id;
            const isLoading = loadingPreviewId === entry.id;

            return (
              <div
                key={entry.id}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 transition-colors ${
                  isActive
                    ? 'bg-sky-50/60 dark:bg-sky-950/20'
                    : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/30'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {entry.siteTitle || entry.hostname}
                  </div>
                  <div className="mt-0.5 text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                    {entry.url}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{formatRelativeTime(entry.capturedAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {entry.stats.pagesCaptured}{' '}
                      {entry.stats.pagesCaptured === 1 ? 'page' : 'pages'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{entry.stats.assetsCaptured} assets</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(entry.stats.zipBytes ?? entry.stats.totalBytes)}</span>
                    {entry.stats.durationMs > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatDurationMs(entry.stats.durationMs)}</span>
                      </>
                    )}
                    {entry.stats.failedAssetsCount > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-amber-600 dark:text-amber-400">
                          {entry.stats.failedAssetsCount} failed
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() =>
                      isActive ? onClosePreview() : onPreviewHistoryEntry(entry)
                    }
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait ${
                      isActive
                        ? 'border-sky-500 bg-sky-600 text-white'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] text-slate-700 dark:text-slate-200 hover:border-sky-500/60 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    {isLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {isLoading ? 'Loading...' : isActive ? 'Hide Preview' : 'Preview'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDownloadHistoryEntry(entry)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onRecapture(entry, true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 px-3.5 py-2 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Recapture</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
