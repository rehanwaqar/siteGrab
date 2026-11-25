import { useState } from 'react';
import { Download, FolderTree, Monitor, Smartphone, CheckCircle2 } from 'lucide-react';
import type { ProgressEvent } from '../types';
import { formatBytes } from '../utils/format';

interface PreviewPanelProps {
  jobId: string;
  siteTitle: string;
  hostname: string;
  zipFilename: string;
  event: ProgressEvent;
  downloaded: boolean;
  onDownload: () => void;
}

export function PreviewPanel({
  jobId,
  siteTitle,
  hostname,
  zipFilename,
  event,
  downloaded,
  onDownload,
}: PreviewPanelProps) {
  const [viewportMode, setViewportMode] = useState<'desktop' | 'mobile'>('desktop');
  const previewUrl = `/api/capture/${encodeURIComponent(jobId)}/preview/index.html`;

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
      {/* Header & Primary Download Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Ready for preview and download</span>
          </div>
          <h2 className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
            {siteTitle || hostname}
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            <span>{event.stats.pagesCaptured} {event.stats.pagesCaptured === 1 ? 'page' : 'pages'}</span>
            <span aria-hidden="true">·</span>
            <span>{event.stats.assetsCaptured} assets</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(event.stats.zipBytes ?? event.stats.totalBytes)} ZIP</span>
            {event.stats.sourceMapsRecovered > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{event.stats.sourceMapsRecovered} recovered source files</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {/* Viewport switcher */}
          <div
            role="group"
            aria-label="Preview viewport width"
            className="flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-1"
          >
            <button
              type="button"
              onClick={() => setViewportMode('desktop')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                viewportMode === 'desktop'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Monitor className="h-3.5 w-3.5" />
              <span>Desktop</span>
            </button>
            <button
              type="button"
              onClick={() => setViewportMode('mobile')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                viewportMode === 'mobile'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span>Mobile</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onDownload}
            disabled={downloaded}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
              downloaded
                ? 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 cursor-not-allowed'
                : 'bg-sky-600 hover:bg-sky-500 text-white cursor-pointer'
            }`}
          >
            <Download className="h-4 w-4 shrink-0" />
            <span>{downloaded ? 'Downloaded (Temp Cleaned)' : `Download ${zipFilename}`}</span>
          </button>
        </div>
      </div>

      {/* Sandboxed Live Preview Frame */}
      {!downloaded ? (
        <div className="bg-slate-100 dark:bg-[#0B0F17] p-4 sm:p-6">
          <div
            className={`mx-auto overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white transition-[max-width] duration-200 ${
              viewportMode === 'mobile' ? 'max-w-[390px]' : 'w-full'
            }`}
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] px-3 py-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
              <span className="truncate">Preview: {hostname}/index.html (rewritten offline bundle)</span>
            </div>
            <iframe
              title={`Captured preview of ${hostname}`}
              src={previewUrl}
              sandbox="allow-scripts allow-forms"
              className="h-[460px] w-full bg-white"
            />
          </div>
        </div>
      ) : (
        <div className="px-6 py-8 text-center text-sm text-slate-600 dark:text-slate-400">
          Your ZIP archive has finished downloading and temporary preview files on the server were removed. Run a new capture anytime.
        </div>
      )}

      {/* Package structure guide */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 px-6 py-3.5 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-2 font-mono">
          <FolderTree className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span>
            index.html · assets/css · assets/js · assets/images · assets/fonts
            {event.stats.sourceMapsRecovered > 0 ? ' · recovered-src' : ''} · README.md
          </span>
        </div>
        <span className="font-mono">
          Run locally: <code className="text-slate-700 dark:text-slate-200">npx serve .</code>
        </span>
      </div>
    </section>
  );
}
