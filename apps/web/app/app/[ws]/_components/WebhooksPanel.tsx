"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import type { WorkspaceRole } from "@formos/domain";
import {
  createWebhookAction,
  listWebhooksAction,
  rotateWebhookSecretAction,
  updateWebhookAction,
  type WebhookMeta,
} from "@/lib/webhooks";

const ALL_EVENTS = ["submission.created", "submission.status_changed"] as const;

/** Webhook endpoint management (owner/admin only). Secrets shown once, never logged. */
export function WebhooksPanel({
  workspaceId,
  myRole,
  forms,
  initialWebhooks,
}: {
  workspaceId: string;
  myRole: WorkspaceRole;
  forms: Array<{ id: string; title: string }>;
  initialWebhooks: WebhookMeta[];
}): React.ReactElement {
  const [hooks, setHooks] = React.useState(initialWebhooks);
  const [shownSecret, setShownSecret] = useState<{ id: string; secret: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [state, submit, pending] = useActionState<{ ok: true } | { error: string } | null, FormData>(
    async (_prev, form) => {
      setError(null);
      setShownSecret(null);
      const url = String(form.get("url") ?? "");
      const events = ALL_EVENTS.filter((e) => form.get(`event-${e}`) === "on");
      const formIdRaw = String(form.get("form_id") ?? "");
      try {
        const created = await createWebhookAction({
          workspaceId,
          url,
          events,
          formId: formIdRaw === "" ? null : formIdRaw,
        });
        setShownSecret({ id: created.id, secret: created.secret });
        setHooks(await listWebhooksAction(workspaceId));
        return { ok: true as const };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not create webhook.";
        setError(message);
        return { error: message };
      }
    },
    null,
  );
  void state;

  async function refresh(): Promise<void> {
    try {
      setHooks(await listWebhooksAction(workspaceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load webhooks.");
    }
  }

  async function onToggle(id: string, isActive: boolean, url: string, events: string[]): Promise<void> {
    setError(null);
    try {
      await updateWebhookAction({ workspaceId, webhookId: id, url, events, isActive });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update webhook.");
    }
  }

  async function onRotate(id: string): Promise<void> {
    setError(null);
    setShownSecret(null);
    try {
      const { secret } = await rotateWebhookSecretAction({ workspaceId, webhookId: id });
      setShownSecret({ id, secret });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rotate secret.");
    }
  }

  if (myRole !== "owner" && myRole !== "admin") return <></>;
  return (
    <div className="card">
      <h2>Webhooks</h2>
      <p className="muted">Outbound HTTPS delivery of submission events, signed with HMAC-SHA256.</p>
      {error !== null ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {shownSecret !== null ? (
        <div role="status">
          <p>
            <strong>Copy this secret now — it will never be shown again:</strong>
          </p>
          <p>
            <code>{shownSecret.secret}</code>
          </p>
        </div>
      ) : null}
      {hooks.length === 0 ? (
        <p className="muted">No webhook endpoints yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Scope</th>
              <th>Events</th>
              <th>Status</th>
              <th>Last delivery</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id}>
                <td>
                  <code>{h.url.length > 48 ? `${h.url.slice(0, 48)}…` : h.url}</code>
                </td>
                <td>{h.form_id ? "form" : "workspace"}</td>
                <td>{h.events.join(", ")}</td>
                <td>
                  <span className="badge">{h.is_active ? "active" : "disabled"}</span>
                  {h.consecutive_failures > 0 ? <span className="muted"> ({h.consecutive_failures} fails)</span> : null}
                </td>
                <td>
                  {h.last_delivery ? (
                    <span className="badge">{h.last_delivery.status}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void onToggle(h.id, !h.is_active, h.url, h.events)}
                    >
                      {h.is_active ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="secondary" onClick={() => void onRotate(h.id)}>
                      Rotate secret
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form action={submit}>
        <h3>Add endpoint</h3>
        <label htmlFor="wh-url">Destination URL (https)</label>
        <input id="wh-url" name="url" type="url" required maxLength={2048} placeholder="https://example.com/hooks/formos" />
        <label htmlFor="wh-form">Form scope</label>
        <select id="wh-form" name="form_id" defaultValue="">
          <option value="">All workspace forms</option>
          {forms.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>Events</legend>
          {ALL_EVENTS.map((e) => (
            <label key={e} style={{ display: "block" }}>
              <input type="checkbox" name={`event-${e}`} defaultChecked /> <code>{e}</code>
            </label>
          ))}
        </fieldset>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add endpoint"}
          </button>
        </div>
      </form>
    </div>
  );
}
