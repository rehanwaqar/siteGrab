interface RateBucket {
  timestamps: number[];
}

export class IpRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly buckets = new Map<string, RateBucket>();

  constructor(maxRequests = 5, windowMs = 10 * 60 * 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  public check(ip: string): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const key = ip || 'unknown';
    const bucket = this.buckets.get(key) ?? { timestamps: [] };

    bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldest = bucket.timestamps[0];
      const retryAfterMs = Math.max(1000, oldest + this.windowMs - now);
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - bucket.timestamps.length),
      retryAfterSeconds: 0,
    };
  }

  public prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, bucket] of this.buckets.entries()) {
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);
      if (bucket.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }
}
