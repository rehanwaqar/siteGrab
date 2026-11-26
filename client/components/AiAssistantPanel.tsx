import { useState, type FormEvent } from 'react';
import { Check, Code2, Loader2, Send, Wrench } from 'lucide-react';
import { getAuthHeaders } from '../firebase';
import type {
  AiAssistantResult,
  AiFileEdit,
  CapturedFileEntry,
  CaptureStats,
} from '../types';

interface AiAssistantPanelProps {
  jobId: string;
  files: CapturedFileEntry[];
  onEditsApplied: (payload: {
    files: CapturedFileEntry[];
    stats: CaptureStats;
    appliedFiles: string[];
  }) => void;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'model';
  text: string;
  edits?: AiFileEdit[];
  applied?: boolean;
}

const QUICK_PROMPTS: Array<{ label: string; mode: 'explain' | 'modify'; prompt: string }> = [
  {
    label: 'Explain HTML, CSS & JS',
    mode: 'explain',
    prompt: 'Explain the structure of index.html, how stylesheets and scripts are wired, and what each key component does.',
  },
  {
    label: 'Make layout responsive',
    mode: 'modify',
    prompt: 'Audit the layout for mobile and tablet responsiveness and update CSS/HTML so nothing overflows on 390px or 768px viewports.',
  },
  {
    label: 'Refine typography & spacing',
    mode: 'modify',
    prompt: 'Improve visual hierarchy, line height, and section spacing in the captured stylesheet/HTML without breaking existing colors or local asset paths.',
  },
  {
    label: 'Fix frontend issues',
    mode: 'modify',
    prompt: 'Inspect the captured HTML, CSS, and JS for broken tags, missing alt attributes, accessibility contrast issues, or console errors and fix them.',
  },
];

const TEXT_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.svg'];

export function AiAssistantPanel({ jobId, files, onEditsApplied }: AiAssistantPanelProps) {
  const editableFiles = files.filter((f) =>
    TEXT_EXTS.some((ext) => f.path.toLowerCase().endsWith(ext)),
  );

  const [mode, setMode] = useState<'explain' | 'modify'>('modify');
  const [selectedFile, setSelectedFile] = useState<string>(
    editableFiles.find((f) => f.path === 'index.html')?.path || editableFiles[0]?.path || '',
  );
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplyingId, setIsApplyingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submitPrompt = async (textToRun: string, overrideMode?: 'explain' | 'modify') => {
    const trimmed = textToRun.trim();
    if (!trimmed || isLoading) return;
    const activeMode = overrideMode ?? mode;

    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
    };

    const nextHistory = [...turns, userTurn];
    setTurns(nextHistory);
    setPrompt('');
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/capture/${encodeURIComponent(jobId)}/ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          prompt: trimmed,
          mode: activeMode,
          selectedFile: selectedFile || undefined,
          history: nextHistory.slice(-6).map((t) => ({ role: t.role, text: t.text })),
        }),
      });

      const data = (await res.json()) as Partial<AiAssistantResult> & { error?: string };
      if (!res.ok) {
        setErrorMsg(data.error || `AI request failed (HTTP ${res.status}).`);
        return;
      }

      const modelTurn: ChatTurn = {
        id: `m-${Date.now()}`,
        role: 'model',
        text: data.explanation || 'Analysis complete.',
        edits: Array.isArray(data.edits) ? data.edits : [],
      };
      setTurns((prev) => [...prev, modelTurn]);
    } catch {
      setErrorMsg('Network error communicating with AI assistant.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submitPrompt(prompt);
  };

  const handleApplyEdits = async (turnId: string, edits: AiFileEdit[]) => {
    if (!edits.length || isApplyingId) return;
    setIsApplyingId(turnId);
    setErrorMsg(null);
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/capture/${encodeURIComponent(jobId)}/apply-edits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ edits }),
      });
      const data = (await res.json()) as {
        appliedFiles?: string[];
        files?: CapturedFileEntry[];
        stats?: CaptureStats;
        error?: string;
      };
      if (!res.ok || !data.files || !data.stats) {
        setErrorMsg(data.error || 'Could not apply changes to captured files.');
        return;
      }

      setTurns((prev) =>
        prev.map((t) => (t.id === turnId ? { ...t, applied: true } : t)),
      );
      onEditsApplied({
        files: data.files,
        stats: data.stats,
        appliedFiles: data.appliedFiles || [],
      });
    } catch {
      setErrorMsg('Failed to apply edits to server workspace.');
    } finally {
      setIsApplyingId(null);
    }
  };

  return (
    <div className="bg-slate-50/50 dark:bg-[#0B0F17] p-4 sm:p-6 space-y-4">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div
            role="group"
            aria-label="Assistant mode"
            className="flex items-center rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-1"
          >
            <button
              type="button"
              onClick={() => setMode('modify')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                mode === 'modify'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              <span>Modify Code</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('explain')}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                mode === 'explain'
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Explain Code</span>
            </button>
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <span>Target file:</span>
          <select
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
            className="max-w-[260px] rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100"
          >
            {editableFiles.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Quick Developer Prompts */}
      <div className="flex flex-wrap gap-2">
        {QUICK_PROMPTS.map((qp) => (
          <button
            key={qp.label}
            type="button"
            disabled={isLoading}
            onClick={() => {
              setMode(qp.mode);
              void submitPrompt(qp.prompt, qp.mode);
            }}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-sky-500/60 hover:text-sky-600 dark:hover:text-sky-400 transition-colors cursor-pointer disabled:opacity-50"
          >
            {qp.label}
          </button>
        ))}
      </div>

      {/* Conversation History */}
      <div className="min-h-[220px] max-h-[380px] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 space-y-4">
        {turns.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400 space-y-1">
            <p className="font-medium text-slate-700 dark:text-slate-300">
              AI Code Assistant inspects the actual captured HTML, CSS, and JS files.
            </p>
            <p>
              Ask to explain scripts, refine styling, add UI components, make layouts responsive, or fix frontend errors—then apply edits directly to the preview and ZIP.
            </p>
          </div>
        ) : (
          turns.map((turn) => (
            <div
              key={turn.id}
              className={`rounded-lg p-3.5 text-xs leading-relaxed ${
                turn.role === 'user'
                  ? 'bg-slate-100 dark:bg-slate-800/60 text-slate-900 dark:text-slate-100 ml-6'
                  : 'border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] text-slate-800 dark:text-slate-200 mr-2'
              }`}
            >
              <div className="mb-1 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                {turn.role === 'user' ? 'You' : 'SiteGrab Assistant'}
              </div>
              <div className="whitespace-pre-wrap">{turn.text}</div>

              {turn.edits && turn.edits.length > 0 && (
                <div className="mt-3 border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                    Proposed file changes ({turn.edits.length}):
                  </div>
                  <ul className="space-y-1 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    {turn.edits.map((edit) => (
                      <li key={edit.filePath}>
                        <span className="text-sky-600 dark:text-sky-400">{edit.filePath}</span>
                        {' — '}
                        <span>{edit.summary}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={turn.applied || isApplyingId === turn.id}
                      onClick={() => void handleApplyEdits(turn.id, turn.edits!)}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                        turn.applied
                          ? 'bg-emerald-600/15 text-emerald-600 dark:text-emerald-400 cursor-default'
                          : 'bg-sky-600 hover:bg-sky-500 text-white'
                      }`}
                    >
                      {isApplyingId === turn.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {turn.applied
                          ? 'Applied to Preview & ZIP'
                          : isApplyingId === turn.id
                            ? 'Applying & Rebuilding ZIP...'
                            : 'Apply Changes & Rebuild ZIP'}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-500" />
            <span>Inspecting captured project files...</span>
          </div>
        )}
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
        >
          {errorMsg}
        </div>
      )}

      {/* Prompt Input */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isLoading}
          placeholder={
            mode === 'explain'
              ? 'Ask how the captured HTML, CSS, or JS works...'
              : 'Describe a styling, layout, component, or frontend fix...'
          }
          className="h-10 flex-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isLoading || !prompt.trim()}
          className="h-10 inline-flex items-center gap-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-4 text-xs font-semibold text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
}
