/**
 * Webhook retry + backoff + classification (Phase 9).
 * Pure logic — the tick pump applies these decisions transactionally.
 * Attempt counting: `attempts` = completed tries so far; delay applies when
 * scheduling attempt N+1. Dead after MAX_ATTEMPTS recorded attempts.
 */

export const MAX_ATTEMPTS = 8;
/** Seconds to wait before retry N (index N-1): ~24h total over 8 attempts. */
export const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 10800, 32400, 43200] as const;
export const MAX_CONSECUTIVE_FAILURES = 50;
export const ATTEMPT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export type DeliveryOutcome =
  | { kind: "delivered"; statusCode: number; responseMs: number }
  | { kind: "retryable"; statusCode: number | null; error: string; responseMs: number }
  | { kind: "permanent"; statusCode: number | null; error: string; responseMs: number };

/**
 * Classify an HTTP outcome. 2xx = delivered. 429/5xx/network/timeout/abort =
 * retryable. Redirects are terminal (never followed: SSRF). Everything else
 * 4xx = permanent.
 */
export function classifyOutcome(input: {
  ok: boolean;
  status: number | null;
  error?: string | undefined;
  responseMs: number;
  redirected: boolean;
}): DeliveryOutcome {
  const { status, error = "request failed", responseMs } = input;
  if (input.redirected) {
    return { kind: "permanent", statusCode: status, error: "redirects are not followed", responseMs };
  }
  if (input.ok && status !== null && status >= 200 && status < 300) {
    return { kind: "delivered", statusCode: status, responseMs };
  }
  if (status === 429 || (status !== null && status >= 500) || status === 408 || status === 425) {
    return { kind: "retryable", statusCode: status, error, responseMs };
  }
  if (status === null) {
    return { kind: "retryable", statusCode: null, error, responseMs };
  }
  return { kind: "permanent", statusCode: status, error, responseMs };
}

/** Seconds until the next attempt after `attempts` recorded tries (1-based). */
export function retryDelaySeconds(attemptsAfterIncrement: number): number | null {
  const idx = attemptsAfterIncrement - 1;
  if (idx < 0 || idx >= RETRY_DELAYS_SECONDS.length) return null;
  return RETRY_DELAYS_SECONDS[idx] as number;
}

/** True when no more retries remain (attempts already includes this try). */
export function isExhausted(attemptsAfterIncrement: number): boolean {
  return attemptsAfterIncrement >= MAX_ATTEMPTS;
}
