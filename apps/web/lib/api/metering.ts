import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "./envelope";

/**
 * API-request metering (Phase 10).
 * Documented rule: every successfully authenticated v1 operation counts
 * exactly once; failed auth never counts; internal routes never count.
 * Enforcement (402) happens BEFORE the operation; counting happens AFTER a
 * successful operation, best-effort so metering can never break traffic.
 * The usage endpoint itself follows the same rule (no carve-outs).
 */

export async function enforceApiQuota(svc: SupabaseClient, workspaceId: string): Promise<void> {
  const { data, error } = await svc.rpc("check_quota", {
    p_workspace_id: workspaceId,
    p_metric: "monthly_api_requests",
    p_quantity: 1,
  });
  if (error) throw new ApiError("INTERNAL", "Could not evaluate quota.", 500);
  const verdict = (data ?? {}) as { allowed?: boolean };
  if (verdict.allowed !== true) {
    throw new ApiError("QUOTA_EXCEEDED", "API request quota exceeded for this workspace.", 402);
  }
}

export async function countApiRequest(svc: SupabaseClient, workspaceId: string, requestId: string): Promise<void> {
  try {
    await svc.rpc("record_usage", {
      p_workspace_id: workspaceId,
      p_metric: "api_request",
      p_source: "api",
      p_source_id: requestId,
      p_quantity: 1,
    });
  } catch {
    // Metering must not break product traffic; undercount is monitored, not fatal.
  }
}
