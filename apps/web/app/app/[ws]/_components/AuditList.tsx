import type * as React from "react";
import type { WorkspaceRole } from "@formos/domain";
import { supabaseServer } from "@/lib/supabaseServer";

/** Recent audit trail (admin/owner only — RLS denies others). */
export async function AuditList({ workspaceId, myRole }: { workspaceId: string; myRole: WorkspaceRole }): Promise<React.ReactElement> {
  if (myRole !== "owner" && myRole !== "admin") return <></>;
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("audit_log")
    .select("action, resource_type, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(25);
  const rows = (data ?? []) as Array<{ action: string; resource_type: string; created_at: string }>;
  return (
    <div className="card">
      <h2>Recent activity</h2>
      {rows.length === 0 ? (
        <p className="muted">No audited events yet.</p>
      ) : (
        <table>
          <thead><tr><th>Event</th><th>Resource</th><th>When</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td><code>{r.action}</code></td><td>{r.resource_type}</td><td>{new Date(r.created_at).toLocaleString()}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
