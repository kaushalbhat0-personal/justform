import type * as React from "react";
import Link from "next/link";
import { listMyMemberships } from "@/lib/identity";
import { createWorkspaceAction } from "@/lib/workspaces";

export default async function AppHome(): Promise<React.ReactElement> {
  const memberships = await listMyMemberships();
  return (
    <div>
      <h1>Workspaces</h1>
      {memberships.length === 0 ? (
        <div className="card">
          <p className="muted">You are not a member of any workspace yet. Create one to begin.</p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Your role</th><th></th></tr></thead>
            <tbody>
              {memberships.map((m) => (
                <tr key={m.workspaceId}>
                  <td>{m.name}</td>
                  <td><span className="badge">{m.role}</span></td>
                  <td><Link href={`/app/${m.workspaceId}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card">
        <h2>Create workspace</h2>
        <form action={createWorkspaceAction}>
          <label htmlFor="ws-name">Workspace name</label>
          <input id="ws-name" name="name" required maxLength={80} placeholder="Acme Inc." />
          <div className="row" style={{ marginTop: 12 }}>
            <button type="submit">Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
