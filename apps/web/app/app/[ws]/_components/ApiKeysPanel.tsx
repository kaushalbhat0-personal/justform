"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import type { WorkspaceRole } from "@formos/domain";
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyMeta, type CreatedApiKey } from "@/lib/apiKeys";

const ALL_SCOPES = ["forms:read", "submissions:read", "webhooks:read", "billing:read"] as const;

/** API key management (owner/admin only). Secrets are shown once, never stored. */
export function ApiKeysPanel({
  workspaceId,
  myRole,
  initialKeys,
}: {
  workspaceId: string;
  myRole: WorkspaceRole;
  initialKeys: ApiKeyMeta[];
}): React.ReactElement {
  const [keys, setKeys] = React.useState(initialKeys);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [state, submit, pending] = useActionState<CreatedApiKey | { error: string } | null, FormData>(
    async (_prev, form) => {
      setCreated(null);
      setError(null);
      const name = String(form.get("name") ?? "");
      const scopes = ALL_SCOPES.filter((s) => form.get(`scope-${s}`) === "on");
      try {
        const key = await createApiKeyAction({ workspaceId, name, scopes });
        const { secret: _shownOnce, ...meta } = key;
        void _shownOnce;
        setKeys((prev) => [meta, ...prev]);
        setCreated(key);
        return key;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not create API key.";
        setError(message);
        return { error: message };
      }
    },
    null,
  );
  void state;

  async function onRevoke(keyId: string): Promise<void> {
    setError(null);
    try {
      await revokeApiKeyAction({ workspaceId, keyId });
      setKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, revoked_at: new Date().toISOString() } : k)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke API key.");
    }
  }

  if (myRole !== "owner" && myRole !== "admin") return <></>;
  return (
    <div className="card">
      <h2>API keys</h2>
      <p className="muted">Workspace-scoped keys for the v1 API. Secrets are shown once and never stored.</p>
      {error !== null ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {created !== null ? (
        <div role="status">
          <p>
            <strong>Copy this secret now — it will never be shown again:</strong>
          </p>
          <p>
            <code>{created.secret}</code>
          </p>
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name || <span className="muted">—</span>}</td>
                <td>
                  <code>{k.prefix}</code>
                </td>
                <td>{k.scopes.join(", ")}</td>
                <td>{k.revoked_at ? <span className="badge">revoked</span> : <span className="badge">active</span>}</td>
                <td>
                  {!k.revoked_at && (
                    <button type="button" className="secondary" onClick={() => void onRevoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form action={submit}>
        <label htmlFor="apikey-name">Name</label>
        <input id="apikey-name" name="name" required maxLength={80} placeholder="Reporting export" />
        <fieldset>
          <legend>Scopes</legend>
          {ALL_SCOPES.map((s) => (
            <label key={s} style={{ display: "block" }}>
              <input type="checkbox" name={`scope-${s}`} defaultChecked={s !== "webhooks:read"} /> <code>{s}</code>
            </label>
          ))}
        </fieldset>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create API key"}
          </button>
        </div>
      </form>
    </div>
  );
}
