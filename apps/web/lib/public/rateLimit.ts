/**
 * Single-instance sliding-window rate limiter (Phase 6 abuse boundary).
 *
 * Bounded, low-cost strategy consistent with the Vercel + Supabase
 * architecture: an in-memory per-key window that sheds abusive bursts.
 * DOCUMENTED LIMIT: each server instance holds its own counters, so the
 * effective global limit scales with instance count. This limiter is a
 * backstop only — authoritative enforcement (caps, schedule, idempotency)
 * lives in the intake RPC transaction. A distributed limiter (Upstash Redis
 * or similar) is the documented upgrade path if abuse data demands it; the
 * call site (`checkPublicRateLimit`) is the single seam to replace.
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export const PUBLIC_SUBMIT_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 30 };

export type RateLimitResult = { ok: true } | { ok: false; retryAfterMs: number };

const buckets = new Map<string, number[]>();

const MAX_BUCKETS = 10_000;

function prune(now: number, windowMs: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, stamps] of buckets) {
    while (stamps.length > 0 && stamps[0] !== undefined && stamps[0] <= now - windowMs) stamps.shift();
    if (stamps.length === 0) buckets.delete(key);
  }
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig = PUBLIC_SUBMIT_LIMIT,
  now: number = Date.now(),
): RateLimitResult {
  prune(now, config.windowMs);
  const stamps = buckets.get(key) ?? [];
  while (stamps.length > 0 && stamps[0] !== undefined && stamps[0] <= now - config.windowMs) stamps.shift();
  if (stamps.length >= config.max) {
    const oldest = stamps[0] ?? now;
    return { ok: false, retryAfterMs: Math.max(1, oldest + config.windowMs - now) };
  }
  stamps.push(now);
  buckets.set(key, stamps);
  return { ok: true };
}

/** Test seam: clear all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}
