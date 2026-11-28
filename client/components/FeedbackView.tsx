import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Github,
  Lightbulb,
  Linkedin,
  Loader2,
  MessageSquarePlus,
  Send,
  Star,
} from 'lucide-react';
import type { FeedbackCategory, FeedbackEntry, FeedbackSummary } from '../types';
import { formatRelativeTime } from '../utils/format';
import {
  extractHttpErrorMessage,
  fetchWithResilience,
  readJsonSafe,
} from '../utils/http';

const CATEGORIES: FeedbackCategory[] = [
  'Experience',
  'Feature Idea',
  'UI / UX',
  'Capture Engine',
  'Bug Report',
];

const RATING_LABELS: Record<number, string> = {
  1: 'Needs work',
  2: 'Fair',
  3: 'Good',
  4: 'Very good',
  5: 'Excellent',
};

export function FeedbackView() {
  const [authorName, setAuthorName] = useState('');
  const [rating, setRating] = useState<number>(5);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [category, setCategory] = useState<FeedbackCategory>('Feature Idea');
  const [experience, setExperience] = useState('');
  const [suggestion, setSuggestion] = useState('');

  const [items, setItems] = useState<FeedbackEntry[]>([]);
  const [averageRating, setAverageRating] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoadingList, setIsLoadingList] = useState(true);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submittedOk, setSubmittedOk] = useState(false);

  useEffect(() => {
    let active = true;
    fetchWithResilience('/api/feedback', { retries: 1 })
      .then((res) => (res.ok ? readJsonSafe<FeedbackSummary>(res) : null))
      .then((data) => {
        if (!active || !data) return;
        setItems(Array.isArray(data.items) ? data.items : []);
        setAverageRating(data.averageRating ?? null);
        setTotalCount(data.totalCount ?? 0);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setIsLoadingList(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!experience.trim() && !suggestion.trim()) {
      setErrorMsg('Please share your experience or a suggestion before sending.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    setSubmittedOk(false);

    try {
      const res = await fetchWithResilience('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authorName: authorName.trim(),
          rating,
          category,
          experience: experience.trim(),
          suggestion: suggestion.trim(),
        }),
        retries: 1,
      });

      const data = await readJsonSafe<
        FeedbackSummary & {
          item?: FeedbackEntry;
          error?: string;
        }
      >(res);

      if (!res.ok || !data) {
        setErrorMsg(extractHttpErrorMessage(res, data, 'Could not send feedback'));
        return;
      }

      setItems(Array.isArray(data.items) ? data.items : []);
      setAverageRating(data.averageRating ?? null);
      setTotalCount(data.totalCount ?? 0);
      setExperience('');
      setSuggestion('');
      setSubmittedOk(true);
    } catch {
      setErrorMsg('Connection interrupted while sending feedback. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeStars = hoverRating || rating;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {/* Intro & Creator Banner */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 sm:p-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-xs font-medium text-sky-600 dark:text-sky-400">
              <MessageSquarePlus className="h-4 w-4" />
              <span>Experience & Improvement Suggestions</span>
            </div>
            <h1 className="mt-2 font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Help make SiteGrab better
            </h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              Share how your capture experience went, report edge cases, or suggest new features to improve the workflow.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <a
              href="https://github.com/rehanwaqar/siteGrab"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/60 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
            >
              <Github className="h-3.5 w-3.5" />
              <span>GitHub</span>
            </a>
            <a
              href="https://www.linkedin.com/in/mohammed-waqar-ahmed-38a856322/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-sky-500/60 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
            >
              <Linkedin className="h-3.5 w-3.5" />
              <span>LinkedIn</span>
            </a>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Feedback Submission Form */}
        <section className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Send Your Experience & Suggestions
          </h2>

          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            {/* Rating & Focus Area */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Overall Experience
                </span>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onMouseEnter={() => setHoverRating(value)}
                      onMouseLeave={() => setHoverRating(0)}
                      onClick={() => setRating(value)}
                      aria-label={`Rate ${value} out of 5 stars`}
                      className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                    >
                      <Star
                        className={`h-5 w-5 transition-colors ${
                          value <= activeStars
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-slate-300 dark:text-slate-700'
                        }`}
                      />
                    </button>
                  ))}
                  <span className="ml-2 text-xs font-mono text-slate-500 dark:text-slate-400">
                    {RATING_LABELS[activeStars]}
                  </span>
                </div>
              </div>

              <label className="block">
                <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Topic
                </span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
                  disabled={isSubmitting}
                  className="h-10 w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] px-3 text-xs text-slate-900 dark:text-slate-100 focus:border-sky-500 focus:outline-none"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Your Name <span className="text-slate-400 font-normal">(optional)</span>
              </span>
              <input
                type="text"
                maxLength={60}
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                disabled={isSubmitting}
                placeholder="Anonymous or your name / handle"
                className="h-10 w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] px-3.5 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                How was your experience using SiteGrab?
              </span>
              <textarea
                rows={3}
                maxLength={1000}
                value={experience}
                onChange={(e) => setExperience(e.target.value)}
                disabled={isSubmitting}
                placeholder="What worked well? Which site or workflow did you test (preview, ZIP export, diagnostics, AI edits)?"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 text-xs leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                What can I do better or add next?
              </span>
              <textarea
                rows={3}
                maxLength={1000}
                value={suggestion}
                onChange={(e) => setSuggestion(e.target.value)}
                disabled={isSubmitting}
                placeholder="Share any improvements, missing features, or UX refinements you would like to see..."
                className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-3 text-xs leading-relaxed text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
              />
            </label>

            {errorMsg && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
              >
                {errorMsg}
              </div>
            )}

            {submittedOk && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Thank you — your experience and suggestion have been saved.</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-5 py-2.5 text-xs font-semibold text-white transition-colors cursor-pointer"
            >
              {isSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>{isSubmitting ? 'Sending...' : 'Send Feedback'}</span>
            </button>
          </form>
        </section>

        {/* Submitted Experience & Suggestions Feed */}
        <section className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-5 py-4">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-sky-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Recent Suggestions ({totalCount})
              </h2>
            </div>
            {averageRating !== null && (
              <div className="flex items-center gap-1 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                <span>{averageRating.toFixed(1)}</span>
              </div>
            )}
          </div>

          <div className="max-h-[520px] overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
            {isLoadingList ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                <span>Loading feedback...</span>
              </div>
            ) : items.length === 0 ? (
              <div className="px-6 py-12 text-center text-xs text-slate-500 dark:text-slate-400 space-y-1">
                <p className="font-medium text-slate-700 dark:text-slate-300">
                  No feedback submitted yet.
                </p>
                <p>
                  Share your experience or suggest an improvement on the left to help shape future updates.
                </p>
              </div>
            ) : (
              items.map((item) => (
                <article key={item.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {item.authorName}
                      </span>
                      <span className="text-[11px] font-mono text-sky-600 dark:text-sky-400 shrink-0">
                        {item.category}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      <span>{item.rating}/5</span>
                    </div>
                  </div>

                  {item.experience && (
                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                      {item.experience}
                    </p>
                  )}

                  {item.suggestion && (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] px-3 py-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Suggestion:{' '}
                      </span>
                      {item.suggestion}
                    </div>
                  )}

                  <div className="text-[11px] font-mono text-slate-400">
                    {formatRelativeTime(item.createdAt)}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
