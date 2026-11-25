interface TermsViewProps {
  onBackToCapture: () => void;
}

export function TermsView({ onBackToCapture }: TermsViewProps) {
  return (
    <article className="mx-auto max-w-3xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Terms of Use & Ownership Policy
      </h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Effective for all captures initiated through SiteGrab.
      </p>

      <div className="mt-6 space-y-6 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        <section>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            1. Ownership & Explicit Permission Requirement
          </h2>
          <p className="mt-2">
            Only use SiteGrab on websites you own, administer, or have explicit authorization from the copyright holder to copy, archive, or inspect. By submitting a URL, you represent and warrant that you hold the legal right to download and store its publicly served assets and source maps.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            2. User Responsibility
          </h2>
          <p className="mt-2">
            You are solely responsible for verifying intellectual property rights, licensing terms, and applicable laws before capturing or redistributing any website content. SiteGrab operates solely as a technical utility and does not grant any license or permission over third-party material.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            3. Automated Safeguards & robots.txt Compliance
          </h2>
          <p className="mt-2">
            SiteGrab enforces strict technical limits to protect target infrastructure and host security:
          </p>
          <ul className="mt-2 list-disc pl-5 space-y-1.5 text-slate-600 dark:text-slate-400">
            <li>Only public <code className="font-mono text-xs">http://</code> and <code className="font-mono text-xs">https://</code> URLs are allowed; private, loopback, and link-local network addresses are blocked before and after DNS resolution and redirects.</li>
            <li>Target <code className="font-mono text-xs">robots.txt</code> rules are checked before capturing entry pages and during multi-page crawls.</li>
            <li>Jobs are isolated in fresh Chromium browser contexts with a 60-second timeout, 100 MB size cap, 500 file cap, and per-IP rate limiting (5 captures per 10 minutes).</li>
            <li>Temporary captured files are deleted automatically after ZIP download completion or expiration.</li>
          </ul>
        </section>
      </div>

      <div className="mt-8 border-t border-slate-200 dark:border-slate-800 pt-5">
        <button
          type="button"
          onClick={onBackToCapture}
          className="inline-flex items-center rounded-lg bg-sky-600 hover:bg-sky-500 px-4 py-2 text-sm font-semibold text-white transition-colors cursor-pointer"
        >
          Return to Capture
        </button>
      </div>
    </article>
  );
}
