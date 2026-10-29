import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@formos/domain";
import { getMembership } from "@/lib/identity";
import { getSubmissionDetail } from "@/lib/submissions";
import { getTaskForSubmission } from "@/lib/workflows";
import { supabaseServer } from "@/lib/supabaseServer";
import { formatTimestamp, iterFields, renderValue } from "@/lib/submissions/present";
import { isSubmissionStatus } from "@/lib/submissions/types";
import { StatusActions } from "./_components/StatusActions";
import { TaskActions } from "./_components/TaskActions";

/** Submission detail: every value interpreted through the pinned snapshot. */
export default async function SubmissionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string; id: string; submissionId: string }>;
  searchParams: Promise<{ status?: string }>;
}): Promise<React.ReactElement> {
  const { ws, id, submissionId } = await params;
  const sp = await searchParams;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  const statusFilter =
    typeof sp.status === "string" && isSubmissionStatus(sp.status) ? sp.status : undefined;
  let detail;
  try {
    detail = await getSubmissionDetail({
      workspaceId: ws,
      formId: id,
      submissionId,
      ...(statusFilter !== undefined ? { statusFilter } : {}),
    });
  } catch {
    notFound();
  }
  const { row, snapshot, publishedVersionNo, prevId, nextId } = detail;
  const task = await getTaskForSubmission(ws, submissionId).catch(() => null);
  const me = await getMembership(ws);
  let members: Array<{ userId: string; email: string }> = [];
  if (task && me && (me.role === "owner" || me.role === "admin" || me.role === "builder")) {
    const supabase = await supabaseServer();
    const { data } = await supabase
      .from("memberships")
      .select("user_id")
      .eq("workspace_id", ws)
      .eq("status", "active")
      .limit(50);
    members = ((data ?? []) as Array<{ user_id: string }>).map((m) => ({
      userId: m.user_id,
      email: m.user_id.slice(0, 8),
    }));
  }

  return (
    <div>
      <p>
        <Link href={`/app/${ws}/forms/${id}/submissions`}>← Submissions</Link>
      </p>
      <h1>Submission</h1>
      <p className="muted">
        <span className="badge">{row.status}</span> Submitted {formatTimestamp(row.submittedAt)} · published
        version {publishedVersionNo}
      </p>
      <div className="card">
        <dl>
          {iterFields(snapshot).map((field) => {
            const rendered = renderValue(field, row.payload[field.key]);
            return (
              <div key={field.id} style={{ marginBottom: "12px" }}>
                <dt style={{ fontWeight: 600 }}>{field.label}</dt>
                <dd style={{ margin: "2px 0 0" }}>
                  {rendered.kind === "email" || rendered.kind === "phone" ? (
                    <a href={rendered.href}>{rendered.text}</a>
                  ) : rendered.kind === "empty" || rendered.kind === "files" ? (
                    <span className="muted">{rendered.text}</span>
                  ) : rendered.kind === "unknown" ? (
                    <span>
                      {rendered.text} <span className="muted">(unrecognized value)</span>
                    </span>
                  ) : (
                    rendered.text
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <StatusActions workspaceId={ws} formId={id} submissionId={row.id} status={row.status} />
      {task !== null ? (
        <>
          <p className="muted">
            <span className="badge">
              {task.instanceStatus === "completed"
                ? "Approved"
                : task.instanceStatus === "rejected"
                  ? "Rejected"
                  : task.status === "claimed"
                    ? "In review"
                    : "Awaiting approval"}
            </span>
          </p>
          {me !== null &&
          can(
            { userId: me.id, workspaceRole: me.role, grants: [], assignments: [] },
            "workflow",
            "read",
          ) ? (
            <TaskActions
              workspaceId={ws}
              formId={id}
              task={{
                id: task.id,
                status: task.status,
                outcome: task.outcome,
                assigneeUserId: task.assigneeUserId,
              }}
              isMine={task.assigneeUserId === me.id || task.claimedBy === me.id}
              canAssign={me.role === "owner" || me.role === "admin"}
              members={members}
            />
          ) : null}
        </>
      ) : null}
      <div className="row">
        {prevId !== null ? (
          <Link href={`/app/${ws}/forms/${id}/submissions/${prevId}`}>← Newer</Link>
        ) : (
          <span className="muted">← Newer</span>
        )}
        {nextId !== null ? (
          <Link href={`/app/${ws}/forms/${id}/submissions/${nextId}`}>Older →</Link>
        ) : (
          <span className="muted">Older →</span>
        )}
      </div>
    </div>
  );
}
