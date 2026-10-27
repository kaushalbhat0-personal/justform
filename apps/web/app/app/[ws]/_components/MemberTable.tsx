import type * as React from "react";
import { can, type WorkspaceRole } from "@formos/domain";
import { removeMemberAction, setRoleAction } from "@/lib/workspaces";
import { supabaseServer } from "@/lib/supabaseServer";

const ROLES: WorkspaceRole[] = ["owner", "admin", "builder", "data_collaborator", "viewer"];

interface Props {
  workspaceId: string;
  myRole: WorkspaceRole;
  myUserId: string;
}

interface MemberRow {
  user_id: string;
  role: WorkspaceRole;
  email: string | null;
}

/** Member management. All mutations are server actions; RLS + RPCs enforce. */
export async function MemberTable({ workspaceId, myRole, myUserId }: Props): Promise<React.ReactElement> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("memberships")
    .select("user_id, role, profiles(email)")
    .eq("workspace_id", workspaceId)
    .order("role");
  const rows = ((data ?? []) as Array<{ user_id: string; role: WorkspaceRole; profiles: { email: string } | null }>).map(
    (m) => ({ user_id: m.user_id, role: m.role, email: m.profiles?.email ?? null }),
  );
  const self = { userId: myUserId, workspaceRole: myRole, grants: [], assignments: [] };
  const canManage = can(self, "member", "update") || can(self, "member", "delete");
  return (
    <div className="card">
      <h2>Members</h2>
      <table>
        <thead><tr><th>Member</th><th>Role</th>{canManage ? <th>Actions</th> : null}</tr></thead>
        <tbody>
          {rows.map((m: MemberRow) => (
            <tr key={m.user_id}>
              <td>{m.email ?? m.user_id}{m.user_id === myUserId ? " (you)" : ""}</td>
              <td><span className="badge">{m.role}</span></td>
              {canManage ? (
                <td>
                  <div className="row">
                    <form action={setRoleAction.bind(null, workspaceId, m.user_id, "admin")}>
                      <button type="submit" className="secondary" disabled={m.user_id === myUserId || m.role === "admin"}>
                        Make admin
                      </button>
                    </form>
                    <form action={setRoleAction.bind(null, workspaceId, m.user_id, "viewer")}>
                      <button type="submit" className="secondary" disabled={m.user_id === myUserId || m.role === "viewer"}>
                        Make viewer
                      </button>
                    </form>
                    <form action={removeMemberAction.bind(null, workspaceId, m.user_id)}>
                      <button type="submit" className="secondary" disabled={m.user_id === myUserId}>Remove</button>
                    </form>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">Full role matrix ({ROLES.join(" → ")}) is enforced server-side; demotions beyond admin/viewer use the same actions in later UI.</p>
    </div>
  );
}
