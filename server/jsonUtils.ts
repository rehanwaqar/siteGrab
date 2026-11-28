export function safeParseModelJson<T = unknown>(rawText: string): T | null {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return null;

  // 1. Direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Continue to fence/object extraction
  }

  // 2. Strip markdown code fences (e.g. ```json ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // Continue to brace extraction
    }
  }

  // 3. Extract outermost JSON object
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(sliced) as T;
    } catch {
      return null;
    }
  }

  return null;
}

export function isRetryableAiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();
  return (
    msg.includes('503') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('429') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('INTERNAL') ||
    msg.includes('DEADLINE_EXCEEDED') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up') ||
    lower.includes('network')
  );
}
