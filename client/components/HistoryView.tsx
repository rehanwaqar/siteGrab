import { Download, RotateCcw, Trash2 } from 'lucide-react';
import type { HistoryEntry } from '../types';
import { formatBytes, formatDurationMs, formatRelativeTime } from '../utils/format';

interface HistoryViewProps {
  history: HistoryEntry[];
  onRecapture: (entry: HistoryEntry, autoRun?: boolean) => void;
  onDownloadHistoryEntry: (entry: HistoryEntry) => void;
  onClearHistory: () => void;
  onSwitchToCapture: () => void;
}

export function HistoryView({
  history,
  onRecapture,
  onDownloadHistoryEntry,
  onClearHistory,
  onSwitchToCapture,
}: HistoryViewProps) {
  return (
    <section className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Project History
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Stored locally in your browser. Recapture any project with its saved options or download an active archive.
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

      {history.length === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-6 py-12 text-center">
          <h2 className="text-base font-medium text-slate-900 dark:text-slate-100">
            No captured projects yet
          </h2>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
            Completed site snapshots will appear here with their file counts, durations, and saved options.
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
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] divide-y divide-slate-200 dark:divide-slate-800">
          {history.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-6 py-4 hover:bg-slate-50/70 dark:hover:bg-slate-800/30 transition-colors"
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
                    {entry.stats.pagesCaptured} {entry.stats.pagesCaptured === 1 ? 'page' : 'pages'}
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

              <div className="flex items-center gap-2 shrink-0">
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
          ))}
        </div>
      )}
    </section>
  );
}
