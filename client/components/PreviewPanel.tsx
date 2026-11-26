import { useState } from 'react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Columns2,
  Download,
  Eye,
  FileCode2,
  FolderTree,
  Loader2,
  Monitor,
  RotateCcw,
  Smartphone,
  Tablet,
} from 'lucide-react';
import type {
  CapturedFileEntry,
  CaptureStats,
  DiagnosticReport,
  ProgressEvent,
} from '../types';
import { formatBytes } from '../utils/format';
import { AiAssistantPanel } from './AiAssistantPanel';

interface PreviewPanelProps {
  jobId: string;
  siteTitle: string;
  hostname: string;
  zipFilename: string;
  event: ProgressEvent;
  files: CapturedFileEntry[];
  diagnostics: DiagnosticReport;
  hasOriginalScreenshot: boolean;
  isDownloading: boolean;
  downloadPercent?: number | null;
  downloadComplete: boolean;
  downloadError: string | null;
  onDownload: () => void;
  onRecapture: () => void;
  onWorkspaceUpdated: (payload: {
    files: CapturedFileEntry[];
    stats: CaptureStats;
    appliedFiles: string[];
  }) => void;
}

const INSPECTABLE_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.md'];

export function PreviewPanel({
  jobId,
  siteTitle,
  hostname,
  zipFilename,
  event,
  files,
  diagnostics,
  hasOriginalScreenshot,
  isDownloading,
  downloadPercent,
  downloadComplete,
  downloadError,
  onDownload,
  onRecapture,
  onWorkspaceUpdated,
}: PreviewPanelProps) {
  const [activeTab, setActiveTab] = useState<'preview' | 'files' | 'diagnostics' | 'ai'>('preview');
  const [viewportMode, setViewportMode] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [compareMode, setCompareMode] = useState<boolean>(false);
  const [previewRevision, setPreviewRevision] = useState<number>(0);

  const [inspectedFile, setInspectedFile] = useState<{
    path: string;
    content: string;
    loading: boolean;
    error?: string;
  } | null>(null);

  const previewUrl = `/api/capture/${encodeURIComponent(jobId)}/preview/index.html?rev=${previewRevision}`;
  const originalScreenshotUrl = `/api/capture/${encodeURIComponent(jobId)}/original-screenshot`;
  const rootFolder = zipFilename.replace(/\.zip$/i, '') || `sitegrab-${hostname}`;

  const totalDiagnosticsIssues =
    diagnostics.brokenImages.length +
    diagnostics.failedResources.length +
    diagnostics.unresolvedLinks.length;

  const handleInspectFile = async (relPath: string) => {
    if (!INSPECTABLE_EXTS.some((ext) => relPath.toLowerCase().endsWith(ext))) {
      setInspectedFile({
        path: relPath,
        content: '',
        loading: false,
        error: 'Binary file (image, font, or media) — previewed inside the live site.',
      });
      return;
    }

    setInspectedFile({ path: relPath, content: '', loading: true });
    try {
      const res = await fetch(
        `/api/capture/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(relPath)}`,
      );
      const data = (await res.json()) as { content?: string; error?: string };
      if (!res.ok || typeof data.content !== 'string') {
        setInspectedFile({
          path: relPath,
          content: '',
          loading: false,
          error: data.error || 'Could not load file.',
        });
        return;
      }
      setInspectedFile({ path: relPath, content: data.content, loading: false });
    } catch {
      setInspectedFile({
        path: relPath,
        content: '',
        loading: false,
        error: 'Network error reading file.',
      });
    }
  };

  const handleEditsApplied = (payload: {
    files: CapturedFileEntry[];
    stats: CaptureStats;
    appliedFiles: string[];
  }) => {
    setPreviewRevision((r) => r + 1);
    onWorkspaceUpdated(payload);
    if (inspectedFile && payload.appliedFiles.includes(inspectedFile.path)) {
      void handleInspectFile(inspectedFile.path);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
      {/* Header & Primary Actions */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>
              {downloadComplete
                ? `Downloaded ${zipFilename} (${files.length} files in ${rootFolder}/)`
                : `Workspace ready (${files.length} files packaged in ${rootFolder}/)`}
            </span>
          </div>
          <h2 className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
            {siteTitle || hostname}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {/* Primary Workspace Tabs */}
          <div
            role="tablist"
            aria-label="Workspace panels"
            className="flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'preview'}
              onClick={() => setActiveTab('preview')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'preview'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              <span>Preview</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'files'}
              onClick={() => setActiveTab('files')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'files'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <FolderTree className="h-3.5 w-3.5" />
              <span>Files ({files.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'diagnostics'}
              onClick={() => setActiveTab('diagnostics')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'diagnostics'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <AlertCircle className="h-3.5 w-3.5" />
              <span>Diagnostics ({totalDiagnosticsIssues})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'ai'}
              onClick={() => setActiveTab('ai')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'ai'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Bot className="h-3.5 w-3.5" />
              <span>AI Assistant</span>
            </button>
          </div>

          <button
            type="button"
            onClick={onRecapture}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#0B0F17] px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Recapture</span>
          </button>

          <button
            type="button"
            onClick={onDownload}
            disabled={isDownloading}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:bg-sky-600/60 px-4 py-2 text-xs font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
          >
            {isDownloading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            ) : (
              <Download className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="tabular-nums">
              {isDownloading
                ? typeof downloadPercent === 'number'
                  ? `Downloading ${downloadPercent}%...`
                  : 'Downloading...'
                : downloadComplete
                  ? 'Download ZIP Again'
                  : 'Download ZIP'}
            </span>
          </button>
        </div>
      </div>

      {downloadError && (
        <div className="border-b border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-6 py-2.5 text-xs text-red-700 dark:text-red-300">
          {downloadError}
        </div>
      )}

      {/* Preview Tab Toolbar + Canvas */}
      {activeTab === 'preview' && (
        <div className="bg-slate-100 dark:bg-[#0B0F17] p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Viewport Switcher: Desktop / Tablet / Mobile */}
            <div
              role="group"
              aria-label="Preview viewport width"
              className="flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-1"
            >
              <button
                type="button"
                onClick={() => setViewportMode('desktop')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewportMode === 'desktop'
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Monitor className="h-3.5 w-3.5" />
                <span>Desktop</span>
              </button>
              <button
                type="button"
                onClick={() => setViewportMode('tablet')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewportMode === 'tablet'
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Tablet className="h-3.5 w-3.5" />
                <span>Tablet</span>
              </button>
              <button
                type="button"
                onClick={() => setViewportMode('mobile')}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  viewportMode === 'mobile'
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Mobile</span>
              </button>
            </div>

            {/* Original vs. Captured Comparison Toggle */}
            {hasOriginalScreenshot && (
              <button
                type="button"
                onClick={() => setCompareMode((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  compareMode
                    ? 'border-sky-500 bg-sky-600 text-white'
                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Columns2 className="h-3.5 w-3.5" />
                <span>{compareMode ? 'Exit Comparison' : 'Compare Original vs. Captured'}</span>
              </button>
            )}
          </div>

          {compareMode && hasOriginalScreenshot ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white flex flex-col">
                <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-300">
                  Original Live Render (Chromium Screenshot)
                </div>
                <div className="flex-1 bg-slate-950 flex items-start justify-center overflow-auto max-h-[480px]">
                  <img
                    src={originalScreenshotUrl}
                    alt={`Original live render of ${hostname}`}
                    className="w-full h-auto object-contain"
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white flex flex-col">
                <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] px-3 py-2 text-xs font-mono text-slate-600 dark:text-slate-300">
                  Captured Offline Bundle ({rootFolder}/index.html)
                </div>
                <iframe
                  title={`Captured preview of ${hostname}`}
                  src={previewUrl}
                  sandbox="allow-scripts allow-forms"
                  className="h-[480px] w-full bg-white"
                />
              </div>
            </div>
          ) : (
            <div
              className={`mx-auto overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white transition-[max-width] duration-200 ${
                viewportMode === 'mobile'
                  ? 'max-w-[390px]'
                  : viewportMode === 'tablet'
                    ? 'max-w-[768px]'
                    : 'w-full'
              }`}
            >
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#111827] px-3 py-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
                <span className="truncate">
                  {rootFolder}/index.html · {viewportMode} viewport
                </span>
              </div>
              <iframe
                title={`Captured preview of ${hostname}`}
                src={previewUrl}
                sandbox="allow-scripts allow-forms"
                className="h-[480px] w-full bg-white"
              />
            </div>
          )}
        </div>
      )}

      {/* Files Inspector Tab */}
      {activeTab === 'files' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]">
          <div className="max-h-[460px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
            {files.length === 0 ? (
              <div className="px-6 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                No files recorded in archive.
              </div>
            ) : (
              files.map((file) => {
                const isSelected = inspectedFile?.path === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => void handleInspectFile(file.path)}
                    className={`w-full flex items-center justify-between gap-4 px-5 py-2.5 text-left text-xs font-mono transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100/70 dark:hover:bg-slate-800/30'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="truncate">
                        {rootFolder}/{file.path}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                      {formatBytes(file.size)}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="max-h-[460px] overflow-auto bg-white dark:bg-[#111827] p-4">
            {!inspectedFile ? (
              <div className="py-16 text-center text-xs text-slate-500 dark:text-slate-400">
                Select any HTML, CSS, JS, JSON, or README file on the left to inspect its captured source code.
              </div>
            ) : inspectedFile.loading ? (
              <div className="flex items-center gap-2 py-8 justify-center text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                <span>Loading {inspectedFile.path}...</span>
              </div>
            ) : inspectedFile.error ? (
              <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400">
                {inspectedFile.error}
              </div>
            ) : (
              <div>
                <div className="mb-2 pb-2 border-b border-slate-100 dark:border-slate-800 text-xs font-mono font-semibold text-slate-700 dark:text-slate-300">
                  {inspectedFile.path}
                </div>
                <pre className="text-[11px] leading-relaxed font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-all">
                  {inspectedFile.content}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Diagnostics Tab */}
      {activeTab === 'diagnostics' && (
        <div className="bg-slate-50/50 dark:bg-[#0B0F17] p-6 space-y-6 max-h-[480px] overflow-y-auto">
          {totalDiagnosticsIssues === 0 ? (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-6 py-10 text-center">
              <CheckCircle2 className="mx-auto h-6 w-6 text-emerald-500" />
              <p className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">
                No broken images, failed resources, or unresolved references detected
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                All requested assets loaded cleanly during Chromium capture.
              </p>
            </div>
          ) : (
            <>
              {diagnostics.brokenImages.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100 mb-2">
                    Broken Images ({diagnostics.brokenImages.length})
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                    {diagnostics.brokenImages.map((item, idx) => (
                      <div key={`${item.src}-${idx}`} className="px-4 py-2.5 text-xs">
                        <div className="font-mono text-red-600 dark:text-red-400 break-all">
                          {item.src}
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400">
                          {item.page} · {item.reason}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {diagnostics.failedResources.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100 mb-2">
                    Failed or Blocked Resources ({diagnostics.failedResources.length})
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                    {diagnostics.failedResources.map((item, idx) => (
                      <div key={`${item.url}-${idx}`} className="px-4 py-2.5 text-xs">
                        <div className="font-mono text-amber-600 dark:text-amber-400 break-all">
                          {item.url}
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400 font-mono">
                          {item.resourceType} · {item.reason}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {diagnostics.unresolvedLinks.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100 mb-2">
                    Unresolved External / Uncaptured Links ({diagnostics.unresolvedLinks.length})
                  </h3>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                    {diagnostics.unresolvedLinks.map((item, idx) => (
                      <div key={`${item.href}-${idx}`} className="px-4 py-2 text-xs">
                        <div className="font-mono text-slate-700 dark:text-slate-300 break-all">
                          {item.href}
                        </div>
                        <div className="mt-0.5 text-slate-500 dark:text-slate-400 font-mono">
                          {item.page} · {item.type}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Optional AI Code Assistant Tab */}
      {activeTab === 'ai' && (
        <AiAssistantPanel
          jobId={jobId}
          files={files}
          onEditsApplied={handleEditsApplied}
        />
      )}

      {/* Package Structure Footer */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 px-6 py-3.5 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-2 font-mono">
          <FolderTree className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span>
            {rootFolder}/ · index.html · assets/ · README.md
            {event.stats.screenshotsCount > 0 ? ' · screenshots/' : ''}
            {event.stats.sourceMapsRecovered > 0 ? ' · recovered-src/' : ''}
          </span>
        </div>
        <span className="font-mono">
          Run locally: <code className="text-slate-700 dark:text-slate-200">npx serve .</code>
        </span>
      </div>
    </section>
  );
}
