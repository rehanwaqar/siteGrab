import { Info } from 'lucide-react';
import type { CaptureStats } from '../types';
import { formatBytes, formatDurationMs } from '../utils/format';

interface ResultsDashboardProps {
  stats: CaptureStats;
  hostname: string;
}

export function ResultsDashboard({ stats, hostname }: ResultsDashboardProps) {
  const metrics = [
    {
      label: 'Pages Captured',
      value: String(stats.pagesCaptured),
      sub: `${stats.htmlCount} HTML ${stats.htmlCount === 1 ? 'file' : 'files'}`,
    },
    {
      label: 'Code Assets',
      value: `${stats.cssCount + stats.jsCount}`,
      sub: `${stats.cssCount} CSS · ${stats.jsCount} JS`,
    },
    {
      label: 'Media & Fonts',
      value: `${stats.imagesCount + stats.fontsCount}`,
      sub: `${stats.imagesCount} images · ${stats.fontsCount} fonts`,
    },
    {
      label: 'Project Size',
      value: formatBytes(stats.totalBytes),
      sub: stats.zipBytes ? `${formatBytes(stats.zipBytes)} ZIP` : 'Uncompressed',
    },
    {
      label: 'Failed Resources',
      value: String(stats.failedAssetsCount),
      sub: stats.failedAssetsCount === 0 ? 'All requests succeeded' : 'See Diagnostics tab',
      alert: stats.failedAssetsCount > 0,
    },
    {
      label: 'Capture Duration',
      value: formatDurationMs(stats.durationMs),
      sub:
        stats.sourceMapsRecovered > 0
          ? `${stats.sourceMapsRecovered} src maps recovered`
          : hostname,
    },
  ];

  return (
    <section
      aria-label="Capture results summary"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden"
    >
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800">
        {metrics.map((metric) => (
          <div key={metric.label} className="px-4 py-4">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {metric.label}
            </div>
            <div
              className={`mt-1 text-xl font-semibold font-mono tabular-nums ${
                metric.alert
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-900 dark:text-slate-100'
              }`}
            >
              {metric.value}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono truncate">
              {metric.sub}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-start gap-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 px-5 py-3 text-xs text-slate-600 dark:text-slate-400">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-slate-400" />
        <span>
          Static capture preserves client-side HTML, CSS, JavaScript, and public assets. Server-side APIs, user authentication, and live databases cannot be reproduced by static capture alone.
        </span>
      </div>
    </section>
  );
}
