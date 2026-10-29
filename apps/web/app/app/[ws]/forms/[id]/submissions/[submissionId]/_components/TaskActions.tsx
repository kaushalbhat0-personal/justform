"use client";

import { useActionState } from "react";
import {
  assignTaskAction,
  claimTaskAction,
  decideTaskAction,
  releaseTaskAction,
} from "@/lib/workflows";

/** Approval actions: claim / release / approve / reject. Plain language, mobile-first. */
export function TaskActions({
  workspaceId,
  formId,
  task,
  isMine,
  canAssign,
  members,
}: {
  workspaceId: string;
  formId: string;
  task: { id: string; status: string; outcome: string; assigneeUserId: string | null };
  isMine: boolean;
  canAssign: boolean;
  members: Array<{ userId: string; email: string }>;
}): React.ReactElement {
  const [state, act, pending] = useActionState<{ ok: boolean; message: string } | null, FormData>(
    async (_prev, formData) => {
      const intent = String(formData.get("intent") ?? "");
      try {
        if (intent === "claim") {
          await claimTaskAction({ workspaceId, formId, taskId: task.id });
          return { ok: true, message: "Claimed. This request is now yours to review." };
        }
        if (intent === "release") {
          await releaseTaskAction({ workspaceId, formId, taskId: task.id });
          return { ok: true, message: "Released back to the team queue." };
        }
        if (intent === "approve" || intent === "reject") {
          await decideTaskAction({ workspaceId, formId, taskId: task.id, outcome: intent === "approve" ? "approved" : "rejected" });
          return {
            ok: true,
            message: intent === "approve" ? "Approved." : "Rejected. The submitter can be notified later.",
          };
        }
        if (intent === "assign") {
          const assignee = String(formData.get("assignee") ?? "");
          if (assignee === "") return { ok: false, message: "Choose a team member." };
          await assignTaskAction({ workspaceId, formId, taskId: task.id, assignee });
          return { ok: true, message: "Assigned." };
        }
        return { ok: false, message: "Unknown action." };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Could not update the task." };
      }
    },
    null,
  );

  if (task.status === "completed" || task.status === "cancelled") {
    return (
      <div className="card" role="status">
        <p>
          {task.outcome === "approved" ? "Approved" : task.outcome === "rejected" ? "Rejected" : "Closed"}{" "}
          <span className="muted">· this decision is final for this workflow version</span>
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: "1rem", margin: "0 0 8px" }}>Approval</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {task.assigneeUserId !== null
          ? isMine
            ? "Assigned to you"
            : "Assigned to a teammate"
          : "Waiting for review — claim it to start"}
      </p>
      <form action={act}>
        <div className="row" style={{ flexWrap: "wrap", gap: "8px" }}>
          {task.status === "pending" ? (
            <button type="submit" name="intent" value="claim" disabled={pending}>
              {pending ? "Working…" : "Claim"}
            </button>
          ) : null}
          {task.status === "claimed" && (isMine || canAssign) ? (
            <button type="submit" name="intent" value="release" className="secondary" disabled={pending}>
              {pending ? "Working…" : "Release"}
            </button>
          ) : null}
          <button type="submit" name="intent" value="approve" disabled={pending}>
            {pending ? "Working…" : "Approve"}
          </button>
          <button type="submit" name="intent" value="reject" className="secondary" disabled={pending}>
            {pending ? "Working…" : "Reject"}
          </button>
        </div>
        {canAssign && members.length > 0 ? (
          <div className="row" style={{ marginTop: "8px", flexWrap: "wrap", gap: "8px" }}>
            <label className="muted" htmlFor="assignee">
              Assign to
            </label>
            <select id="assignee" name="assignee" defaultValue="">
              <option value="">Choose…</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.email}
                </option>
              ))}
            </select>
            <button type="submit" name="intent" value="assign" className="secondary" disabled={pending}>
              Assign
            </button>
          </div>
        ) : null}
      </form>
      {state !== null ? (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "muted" : "error"}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
