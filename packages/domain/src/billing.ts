/**
 * Billing/metering domain model (Phase 10 — metering-only, no payments).
 *
 * Enforcement authority lives in Postgres (check_quota / get_usage_summary);
 * this module holds the shared vocabulary plus the pure presentation math
 * (remaining, percentages) used by the Billing UI and API responses.
 * No secrets, no I/O, no imports.
 */

export const BILLING_PLANS = ["free", "pro", "business"] as const;
export type BillingPlan = (typeof BILLING_PLANS)[number];

/** Quota-evaluated dimensions (state + period counters). */
export const QUOTA_METRICS = [
  "active_forms",
  "monthly_submissions",
  "monthly_api_requests",
  "monthly_webhook_deliveries",
  "storage_bytes",
] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];

/** Raw usage event metrics (the idempotent ledger). */
export const USAGE_METRICS = ["submission", "api_request", "webhook_attempt"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export interface EntitlementVerdict {
  allowed: boolean;
  metric: QuotaMetric;
  current: number | null;
  /** NULL = unlimited (or unmetered). */
  limit: number | null;
  /** NULL when unlimited/unmetered; otherwise clamped to >= 0. */
  remaining: number | null;
  reason: string;
}

/**
 * Pure entitlement rule (mirrors the SQL boundary; presentation/edge-case
 * use — enforcement decisions come from check_quota).
 */
export function evaluateEntitlement(input: {
  metric: QuotaMetric;
  current: number | null;
  limit: number | null;
  quantity?: number;
}): EntitlementVerdict {
  const quantity = input.quantity ?? 1;
  if (input.limit === null) {
    return {
      allowed: true,
      metric: input.metric,
      current: input.current,
      limit: null,
      remaining: null,
      reason: input.current === null ? "unmetered" : "ok",
    };
  }
  if (input.current === null) {
    return {
      allowed: true,
      metric: input.metric,
      current: null,
      limit: input.limit,
      remaining: null,
      reason: "unmetered",
    };
  }
  if (input.current + quantity <= input.limit) {
    return {
      allowed: true,
      metric: input.metric,
      current: input.current,
      limit: input.limit,
      remaining: Math.max(input.limit - input.current, 0),
      reason: "ok",
    };
  }
  return {
    allowed: false,
    metric: input.metric,
    current: input.current,
    limit: input.limit,
    remaining: 0,
    reason: "quota_exceeded",
  };
}

/**
 * Usage percentage for meter bars. NULL when unbounded, unmetered, or the
 * limit is zero (avoids division by zero and meaningless 100% bars).
 */
export function usagePercent(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export function isBillingPlan(value: string): value is BillingPlan {
  return (BILLING_PLANS as readonly string[]).includes(value);
}
