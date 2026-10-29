"use client";

import { useActionState } from "react";
import { setPublicationActiveAction } from "@/lib/publications";

/**
 * Publication lifecycle controls (Phase 6): the public URL is provisioned
 * automatically on publish; this panel exposes availability + activation.
 */

type PanelResult = { ok: true; isActive: boolean } | { ok: false; message: string } | null;

export function PublicationPanel({
  workspaceId,
  formId,
  publicId,
  publicUrl,
  isActive,
  publishedVersionNo,
}: {
  workspaceId: string;
  formId: string;
  publicId: string | null;
  publicUrl: string | null;
  isActive: boolean;
  publishedVersionNo: number | null;
}): React.ReactElement {
  const [state, toggle, pending] = useActionState<PanelResult, FormData>(async (_prev, formData) => {
    const next = String(formData.get("isActive") ?? "") === "true";
    try {
      const res = await setPublicationActiveAction({ workspaceId, formId, isActive: next });
      return { ok: true, isActive: res.isActive };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Could not update the publication." };
    }
  }, null);

  const active = state !== null && state.ok ? state.isActive : isActive;

  if (publicId === null || publicUrl === null) {
    return (
      <div>
        <h2>Public form</h2>
        <p className="muted">No public link yet — publish the form to create one.</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Public form</h2>
      <p>
        <span className="badge">{active ? "live" : "inactive"}</span>{" "}
        {publishedVersionNo !== null ? <span className="muted">serving published version {publishedVersionNo}</span> : null}
      </p>
      <p>
        <a href={publicUrl} target="_blank" rel="noreferrer">
          {publicUrl}
        </a>
      </p>
      <form action={toggle}>
        <input type="hidden" name="isActive" value={active ? "false" : "true"} />
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Updating…" : active ? "Deactivate public link" : "Reactivate public link"}
        </button>
      </form>
      {state !== null && !state.ok ? (
        <p role="alert" className="error">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
