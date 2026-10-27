"use client";
import type * as React from "react";
import { useActionState } from "react";
import type { WorkspaceRole } from "@formos/domain";
import { inviteAction } from "@/lib/workspaces";

type State = { ok: true; link: string } | { ok: false; error: string } | null;

/** Invitation composer. The accept link is shown ONCE and never logged. */
export function InvitePanel({ workspaceId, myRole }: { workspaceId: string; myRole: WorkspaceRole }): React.ReactElement {
  const [state, submit, pending] = useActionState<State, FormData>(
    async (_prev, form) =>
      inviteAction(workspaceId, String(form.get("email") ?? ""), (form.get("role") as WorkspaceRole) ?? "viewer"),
    null,
  );
  if (myRole !== "owner" && myRole !== "admin") return <></>;
  return (
    <div className="card">
      <h2>Invite member</h2>
      {state && !state.ok ? <div className="error" role="alert">{state.error}</div> : null}
      {state && state.ok ? (
        <div>
          <p>Share this link once — it expires in 7 days and works a single time:</p>
          <p><code>{state.link}</code></p>
        </div>
      ) : null}
      <form action={submit}>
        <label htmlFor="inv-email">Email</label>
        <input id="inv-email" name="email" type="email" required placeholder="teammate@example.com" />
        <label htmlFor="inv-role">Role</label>
        <select id="inv-role" name="role" defaultValue="viewer">
          <option value="viewer">Viewer</option>
          <option value="data_collaborator">Data Collaborator</option>
          <option value="builder">Builder</option>
          <option value="admin">Admin</option>
        </select>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" disabled={pending}>{pending ? "Inviting…" : "Send invite"}</button>
        </div>
      </form>
    </div>
  );
}
