import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FeedbackCategory, FeedbackEntry } from './types.ts';

const DATA_DIR = path.resolve(process.cwd(), '.sitegrab-data');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const MAX_FEEDBACK_ITEMS = 200;

const ALLOWED_CATEGORIES = new Set<FeedbackCategory>([
  'Experience',
  'Feature Idea',
  'UI / UX',
  'Capture Engine',
  'Bug Report',
]);

let writeQueue: Promise<unknown> = Promise.resolve();

export class FeedbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackValidationError';
  }
}

async function readFeedbackList(): Promise<FeedbackEntry[]> {
  try {
    const raw = await fsp.readFile(FEEDBACK_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FeedbackEntry =>
        Boolean(item) &&
        typeof item.id === 'string' &&
        typeof item.authorName === 'string' &&
        typeof item.rating === 'number' &&
        typeof item.category === 'string' &&
        typeof item.experience === 'string' &&
        typeof item.suggestion === 'string' &&
        typeof item.createdAt === 'number',
    );
  } catch {
    return [];
  }
}

function summarize(items: FeedbackEntry[]): {
  items: FeedbackEntry[];
  averageRating: number | null;
  totalCount: number;
} {
  const totalCount = items.length;
  if (totalCount === 0) {
    return { items: [], averageRating: null, totalCount: 0 };
  }
  const sum = items.reduce((acc, item) => acc + item.rating, 0);
  const averageRating = Math.round((sum / totalCount) * 10) / 10;
  return { items, averageRating, totalCount };
}

export async function getFeedbackSummary(): Promise<{
  items: FeedbackEntry[];
  averageRating: number | null;
  totalCount: number;
}> {
  const items = await readFeedbackList();
  return summarize(items);
}

export async function addFeedbackEntry(input: {
  authorName?: unknown;
  rating?: unknown;
  category?: unknown;
  experience?: unknown;
  suggestion?: unknown;
}): Promise<{
  item: FeedbackEntry;
  items: FeedbackEntry[];
  averageRating: number | null;
  totalCount: number;
}> {
  const ratingNum = Number(input.rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    throw new FeedbackValidationError('Please select a rating from 1 to 5 stars.');
  }

  const rawCategory = typeof input.category === 'string' ? input.category.trim() : 'Experience';
  const category: FeedbackCategory = ALLOWED_CATEGORIES.has(rawCategory as FeedbackCategory)
    ? (rawCategory as FeedbackCategory)
    : 'Experience';

  const authorRaw = typeof input.authorName === 'string' ? input.authorName.trim() : '';
  const authorName = authorRaw.slice(0, 60) || 'Anonymous';

  const experience =
    typeof input.experience === 'string' ? input.experience.trim().slice(0, 1000) : '';
  const suggestion =
    typeof input.suggestion === 'string' ? input.suggestion.trim().slice(0, 1000) : '';

  if (!experience && !suggestion) {
    throw new FeedbackValidationError(
      'Please share your experience or suggest what can be improved.',
    );
  }

  const entry: FeedbackEntry = {
    id: crypto.randomUUID(),
    authorName,
    rating: ratingNum,
    category,
    experience,
    suggestion,
    createdAt: Date.now(),
  };

  const result = writeQueue.then(async () => {
    const existing = await readFeedbackList();
    const updated = [entry, ...existing].slice(0, MAX_FEEDBACK_ITEMS);
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(FEEDBACK_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return {
      item: entry,
      ...summarize(updated),
    };
  });

  writeQueue = result.catch(() => undefined);
  return result;
}
