"use server";
import "server-only";
import { can, DomainError } from "@formos/domain";
import { getMembership, requireUser } from "./identity";
import { supabaseServer } from "./supabaseServer";

/**
 * Billing & usage reads (Phase 10, metering-only).
 * Read-only: no plan/limit/usage mutation exists anywhere in the product.
 * Billing read is admin-floor (owner/admin); the RPC re-verifies membership.
 */

export interface UsageMeter {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  metered?: boolean;
}

export interface UsageSummary {
  plan: string;
  billing_status: string;
  period_start: string;
  period_end: string;
  metrics: {
    active_forms: UsageMeter;
    monthly_submissions: UsageMeter;
    monthly_api_requests: UsageMeter;
    monthly_webhook_deliveries: UsageMeter;
    storage_bytes: UsageMeter & { metered: boolean };
  };
}

function fail(message: string): never {
  throw new DomainError({ code: "forbidden", message });
}

export async function getUsageSummaryAction(workspaceId: string): Promise<UsageSummary> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "billing", "read")) {
    fail("Not authorized to view billing.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("get_usage_summary", { p_workspace_id: workspaceId });
  if (error || !data) throw new DomainError({ code: "internal", message: "Could not load billing usage." });
  return data as UsageSummary;
}
