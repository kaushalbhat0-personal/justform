"use client";

import { useActionState } from "react";
import { setSubmissionStatusAction } from "@/lib/submissions";
import type { SubmissionStatus } from "@/lib/submissions/types";

/** Lifecycle actions (archive / unarchive). Audited server-side, payload-free. */
export function StatusActions({
  workspaceId,
  formId,
  submissionId,
  status,
}: {
  workspaceId: string;
  formId: string;
  submissionId: string;
  status: SubmissionStatus;
}): React.ReactElement {
  const [state, act, pending] = useActionState<{ ok: boolean; message: string } | null, FormData>(
    async (_prev, formData) => {
      const next = String(formData.get("status") ?? "");
      if (next !== "read" && next !== "archived") return { ok: false, message: "Invalid status." };
      try {
        await setSubmissionStatusAction({ workspaceId, formId, submissionId, status: next });
        return { ok: true, message: next === "archived" ? "Submission archived." : "Submission restored to read." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Could not update the submission." };
      }
    },
    null,
  );

  return (
    <div className="card">
      <form action={act}>
        <input type="hidden" name="status" value={status === "archived" ? "read" : "archived"} />
        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Updating…" : status === "archived" ? "Unarchive" : "Archive"}
        </button>
      </form>
      {state !== null ? (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "muted" : "error"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
