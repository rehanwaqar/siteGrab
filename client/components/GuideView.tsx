import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Code2,
  Download,
  FileArchive,
  FolderTree,
  Globe,
  History,
  Image as ImageIcon,
  Lock,
  MonitorSmartphone,
  Sparkles,
  Terminal,
} from 'lucide-react';

interface GuideViewProps {
  isSignedIn: boolean;
  onBackToMain: () => void;
}

export function GuideView({ isSignedIn, onBackToMain }: GuideViewProps) {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            How to Use SiteGrab
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Step-by-step guide to capturing websites, generating sites from screenshots, editing with AI, and exporting VS Code-ready archives.
          </p>
        </div>
        <button
          type="button"
          onClick={onBackToMain}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>{isSignedIn ? 'Back to Capture' : 'Back to Sign In'}</span>
        </button>
      </div>

      {/* 4 Core Workflow Steps */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 text-xs font-bold text-sky-600 dark:text-sky-400 font-mono">
              01
            </span>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Lock className="h-4 w-4 text-sky-500" />
              <span>Sign In to Your Private Workspace</span>
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Sign in with <strong>Google</strong>, <strong>Apple</strong>, <strong>GitHub</strong>, or create an{' '}
            <strong>Email &amp; Password</strong> account (verify your email via the inbox link). Every capture, generated project, and history snapshot is private to your account.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 text-xs font-bold text-sky-600 dark:text-sky-400 font-mono">
              02
            </span>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Globe className="h-4 w-4 text-sky-500" />
              <span>Enter a URL, Screenshot, or ZIP</span>
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Paste a public URL (e.g., <code className="font-mono">https://example.com</code>) and click{' '}
            <strong>Capture Site</strong>. No live link? Use{' '}
            <strong>Generate from Screenshot</strong> or{' '}
            <strong>Upload Project ZIP</strong> directly beneath the URL bar.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 text-xs font-bold text-sky-600 dark:text-sky-400 font-mono">
              03
            </span>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <MonitorSmartphone className="h-4 w-4 text-sky-500" />
              <span>Preview, Inspect &amp; Edit with AI</span>
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Once files are built, test responsiveness in <strong>Desktop, Tablet, and Mobile</strong> views, compare against the original screenshot, check broken-asset diagnostics, or ask the{' '}
            <strong>AI Code Assistant</strong> to update styles, layout, or scripts directly on your captured files.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 space-y-2.5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/15 text-xs font-bold text-sky-600 dark:text-sky-400 font-mono">
              04
            </span>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <Download className="h-4 w-4 text-sky-500" />
              <span>Download &amp; Open in VS Code</span>
            </h2>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Click <strong>Download ZIP</strong> when you are ready (auto-download stays off by default). Unzip the folder, open it in VS Code, and start a local preview server using the included{' '}
            <code className="font-mono">README.md</code> instructions.
          </p>
        </div>
      </section>

      {/* Three Input Modes Explained */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-4">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          3 Ways to Build a Project
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/70 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <Globe className="h-4 w-4 text-sky-500" />
              <span>1. Live URL Capture</span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
              Renders pages with headless Chromium, downloads HTML, CSS, JS, images, fonts, and source maps, and rewrites links for offline viewing. If a site blocks automated browsers, SiteGrab automatically generates an offline clone or offers Smart Recovery.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/70 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <ImageIcon className="h-4 w-4 text-sky-500" />
              <span>2. Screenshot to Code</span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
              Upload any PNG, JPEG, WebP, or GIF mockup or screenshot plus optional instructions (e.g., color theme or interactive tabs) to generate clean responsive HTML, CSS, and JavaScript.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/70 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <FileArchive className="h-4 w-4 text-sky-500" />
              <span>3. Website Builder ZIP</span>
            </div>
            <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
              Upload a ZIP exported from Bolt, Lovable, or GitHub to inspect files, check relative asset paths, run AI modifications, and re-export cleanly organized code.
            </p>
          </div>
        </div>
      </section>

      {/* Capture Options + Output Structure */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <FolderTree className="h-4 w-4 text-sky-500" />
            <span>Clean VS Code Output Structure</span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Every exported ZIP uses relative paths so it works both offline and on any static host:
          </p>
          <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3.5 text-[11px] font-mono text-slate-800 dark:text-slate-200 overflow-x-auto leading-relaxed">
{`project-root/
├── index.html          # Main landing page
├── pages/              # Subpages (when Crawl Depth > 0)
├── css/                # Formatted stylesheets
├── js/                 # Client scripts
├── assets/
│   ├── images/         # Captured images & icons
│   ├── fonts/          # Webfonts (.woff2, .ttf, etc.)
│   └── screenshots/    # Optional viewport captures
├── package.json        # Ready for npx serve
└── README.md           # Local preview setup guide`}
          </pre>
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Terminal className="h-4 w-4 text-sky-500" />
            <span>Key Options &amp; Tips</span>
          </div>
          <ul className="space-y-2.5 text-xs text-slate-600 dark:text-slate-400">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                <strong>Crawl Depth (Single / D1–D3):</strong> Keep on <strong>Single</strong> for fast single-page captures, or increase depth + Max Pages to follow internal navigation links.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                <strong>Format Code &amp; Source Maps:</strong> Formats HTML/CSS/JS with Prettier and recovers readable frontend sources when public source maps exist.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <Sparkles className="h-3.5 w-3.5 text-sky-500 shrink-0 mt-0.5" />
              <span>
                <strong>AI Code Assistant:</strong> Open the <strong>AI Assistant</strong> tab inside the workspace after capture to ask questions, fix responsive CSS, or edit files before downloading.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <History className="h-3.5 w-3.5 text-sky-500 shrink-0 mt-0.5" />
              <span>
                <strong>History Tab:</strong> Revisit your past captures anytime to download active archives or click <strong>Recapture</strong> with your saved settings.
              </span>
            </li>
          </ul>
        </section>
      </div>

      {/* Run locally & Scope Limitations */}
      <section className="rounded-xl border border-amber-300/80 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/20 p-5 space-y-2 text-xs">
        <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Important Scope &amp; Responsible Use</span>
        </div>
        <ul className="space-y-1.5 text-amber-800 dark:text-amber-300/90 list-disc pl-5 leading-relaxed">
          <li>
            Only capture websites you own, built yourself, or have explicit permission to copy. SiteGrab respects <code className="font-mono">robots.txt</code> and blocks private/internal network addresses.
          </li>
          <li>
            Static capture exports frontend code (HTML, CSS, JS, images, fonts). Server-side APIs, databases, and authenticated user sessions cannot be duplicated by static capture alone.
          </li>
          <li>
            To preview a downloaded ZIP locally, unzip it, open a terminal inside the folder, and run{' '}
            <code className="font-mono font-semibold">npx serve .</code> (or use the VS Code Live Server extension).
          </li>
        </ul>
      </section>

      <div className="flex justify-center pt-1">
        <button
          type="button"
          onClick={onBackToMain}
          className="inline-flex items-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 px-5 py-2.5 text-xs font-semibold text-white transition-colors cursor-pointer"
        >
          <Code2 className="h-4 w-4" />
          <span>{isSignedIn ? 'Start Capturing Now' : 'Go to Sign In'}</span>
        </button>
      </div>
    </div>
  );
}
