import "server-only";
import { uuidv7 } from "@formos/database";
import type { AuditAction } from "@formos/domain";
import { supabaseServer } from "./supabaseServer";

export interface AuditWrite {
  workspaceId: string;
  actorId: string | null;
  actorType: "user" | "api_key" | "system";
  action: AuditAction;
  resourceType: string;
  resourceId?: string;
  diff?: Record<string, unknown>;
  requestId?: string;
}

/** Append-only audit writer (members may INSERT own-workspace rows per RLS). */
export async function writeAudit(entry: AuditWrite): Promise<void> {
  const supabase = await supabaseServer();
  const { error } = await supabase.from("audit_log").insert({
    id: uuidv7(),
    workspace_id: entry.workspaceId,
    actor_id: entry.actorId,
    actor_type: entry.actorType,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    diff: entry.diff ?? null,
    request_id: entry.requestId ?? null,
  });
  if (error) throw new Error(`audit write failed: ${error.message}`);
}
