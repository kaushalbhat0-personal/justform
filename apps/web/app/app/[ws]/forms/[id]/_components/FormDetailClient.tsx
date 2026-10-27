"use client";

import { useActionState } from "react";
import { publishAction, republishAction, updateDraftAction } from "@/lib/forms";

type ActionResult = { ok: true; revision?: number; publishedVersion?: number } | { ok: false; conflict: true; expectedRevision: number; currentRevision: number } | null;

function toResult(value: Awaited<ReturnType<typeof updateDraftAction>> | Awaited<ReturnType<typeof publishAction>>): ActionResult {
  if (!value.ok) return { ok: false, conflict: true, expectedRevision: value.expectedRevision, currentRevision: value.currentRevision };
  const out: { ok: true; revision?: number; publishedVersion?: number } = { ok: true };
  if ("revision" in value) out.revision = value.revision;
  if ("publishedVersion" in value) out.publishedVersion = value.publishedVersion;
  return out;
}

function ResultBanner({ result, label }: { result: ActionResult; label: string }): React.ReactElement | null {
  if (!result) return null;
  if (result.ok) {
    return (
      <p role="status">
        {label} saved
        {result.revision !== undefined ? ` — revision ${result.revision}` : ""}
        {result.publishedVersion !== undefined ? ` — published version ${result.publishedVersion}` : ""}
      </p>
    );
  }
  return (
    <p role="alert">
      Draft conflict: your base was revision {result.expectedRevision}, the server is at revision {result.currentRevision}.
      Reload the page to merge — your unsaved text above is preserved.
    </p>
  );
}

/** Draft editor + publish + republish (developer surface; the builder arrives in Phase 5). */
export function FormDetailClient({
  workspaceId,
  formId,
  revision,
  initial,
  versions,
}: {
  workspaceId: string;
  formId: string;
  revision: number;
  initial: { title: string; key: string; description: string; status: string; documentJson: string };
  versions: Array<{ published_version_no: number }>;
}): React.ReactElement {
  const [draftState, saveDraft, draftPending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) => {
      const expectedRevision = Number(formData.get("expectedRevision"));
      const res = await updateDraftAction({
        workspaceId,
        formId,
        expectedRevision,
        title: String(formData.get("title") ?? ""),
        key: String(formData.get("key") ?? ""),
        description: String(formData.get("description") ?? ""),
        status: String(formData.get("status") ?? "active") === "archived" ? "archived" : "active",
        documentJson: String(formData.get("document") ?? ""),
      });
      return toResult(res);
    },
    null,
  );
  const [publishState, publish, publishPending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) => toResult(await publishAction({ workspaceId, formId, expectedRevision: Number(formData.get("expectedRevision")) })),
    null,
  );
  const [republishState, republish, republishPending] = useActionState<ActionResult, FormData>(
    async (_prev, formData) =>
      toResult(
        await republishAction({
          workspaceId,
          formId,
          publishedVersion: Number(formData.get("publishedVersion")),
          expectedRevision: Number(formData.get("expectedRevision")),
        }),
      ),
    null,
  );

  return (
    <div>
      <h2>Draft (revision {revision})</h2>
      <form action={saveDraft}>
        <input type="hidden" name="expectedRevision" value={revision} />
        <label>
          Title <input name="title" required maxLength={200} defaultValue={initial.title} />
        </label>
        <label>
          Key <input name="key" required defaultValue={initial.key} />
        </label>
        <label>
          Description <input name="description" maxLength={500} defaultValue={initial.description} />
        </label>
        <label>
          Status
          <select name="status" defaultValue={initial.status}>
            <option value="active">active</option>
            <option value="archived">archived (unpublished)</option>
          </select>
        </label>
        <label>
          Canonical document (JSON)
          <textarea name="document" required rows={16} defaultValue={initial.documentJson} />
        </label>
        <button type="submit" disabled={draftPending}>
          {draftPending ? "Saving…" : "Save draft"}
        </button>
      </form>
      <ResultBanner result={draftState} label="Draft" />

      <h2>Publish</h2>
      <form action={publish}>
        <input type="hidden" name="expectedRevision" value={revision} />
        <button type="submit" disabled={publishPending}>
          {publishPending ? "Publishing…" : `Publish revision ${revision}`}
        </button>
      </form>
      <ResultBanner result={publishState} label="Publish" />

      <h2>Published versions</h2>
      {versions.length === 0 ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <ul>
          {versions.map((v) => (
            <li key={v.published_version_no}>
              <a href={`?v=${v.published_version_no}`}>version {v.published_version_no}</a>{" "}
              <form action={republish} style={{ display: "inline" }}>
                <input type="hidden" name="expectedRevision" value={revision} />
                <input type="hidden" name="publishedVersion" value={v.published_version_no} />
                <button type="submit" disabled={republishPending}>
                  Rollback by republish
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <ResultBanner result={republishState} label="Republish" />
    </div>
  );
}
