import { Check, Loader2 } from 'lucide-react';
import type { CaptureStage, ProgressEvent } from '../types';
import { formatBytes } from '../utils/format';

interface ProgressPanelProps {
  event: ProgressEvent;
  targetHostname: string;
}

const ORDERED_STAGES: Array<{ key: CaptureStage; label: string }> = [
  { key: 'validating', label: 'Validate URL & robots' },
  { key: 'launching', label: 'Browser launch' },
  { key: 'capturing', label: 'Page load, crawl & assets' },
  { key: 'recovering', label: 'Source maps' },
  { key: 'rewriting', label: 'Rewrite paths' },
  { key: 'formatting', label: 'Format code' },
  { key: 'zipping', label: 'Package ZIP' },
];

const STAGE_RANK: Record<CaptureStage, number> = {
  queued: 0,
  validating: 1,
  launching: 2,
  capturing: 3,
  recovering: 4,
  rewriting: 5,
  formatting: 6,
  zipping: 7,
  ready: 8,
  error: -1,
};

export function ProgressPanel({ event, targetHostname }: ProgressPanelProps) {
  const currentRank = STAGE_RANK[event.stage] ?? 0;
  const pct = Math.max(0, Math.min(100, event.percent));

  return (
    <section
      aria-live="polite"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            {event.stage !== 'ready' && event.stage !== 'error' && (
              <Loader2 className="h-4 w-4 animate-spin text-sky-600 dark:text-sky-400 shrink-0" />
            )}
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
              {event.message}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
            {event.detail || targetHostname}
          </p>
        </div>

        <div className="text-right shrink-0">
          <span className="text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {pct}%
          </span>
        </div>
      </div>

      {/* Progress track */}
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          className="h-full rounded-full bg-sky-600 dark:bg-sky-500 transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Live tabular counters */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400 font-mono tabular-nums">
        <span>Pages: {event.stats.pagesCaptured}</span>
        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
        <span>Assets: {event.stats.assetsCaptured}</span>
        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
        <span>Captured: {formatBytes(event.stats.totalBytes)}</span>
        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
        <span>Failed: {event.stats.failedAssetsCount}</span>
        <span aria-hidden="true" className="text-slate-300 dark:text-slate-700">·</span>
        <span>Source maps: {event.stats.sourceMapsRecovered}</span>
      </div>

      {/* Stage checklist */}
      <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 border-t border-slate-100 dark:border-slate-800/80 pt-4">
        {ORDERED_STAGES.map((step) => {
          const rank = STAGE_RANK[step.key];
          const isDone = currentRank > rank || event.stage === 'ready';
          const isActive = currentRank === rank && event.stage !== 'ready';
          return (
            <div
              key={step.key}
              className={`flex items-center gap-1.5 text-xs ${
                isDone
                  ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                  : isActive
                    ? 'text-sky-600 dark:text-sky-400 font-medium'
                    : 'text-slate-400 dark:text-slate-500'
              }`}
            >
              {isDone ? (
                <Check className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <span
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    isActive ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                />
              )}
              <span className="truncate">{step.label}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
