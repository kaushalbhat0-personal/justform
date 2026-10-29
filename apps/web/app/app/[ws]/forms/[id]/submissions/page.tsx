import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { getFormDetail } from "@/lib/forms";
import { listSubmissions } from "@/lib/submissions";
import { getTasksForSubmissions } from "@/lib/workflows";
import { formatTimestamp } from "@/lib/submissions/present";
import { isSubmissionStatus } from "@/lib/submissions/types";
import { SubmissionFilters } from "./_components/SubmissionFilters";

/** Workspace submission inbox: paginated, searchable, filterable list. */
export default async function SubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string; id: string }>;
  searchParams: Promise<{ status?: string; q?: string; from?: string; to?: string; cursor?: string }>;
}): Promise<React.ReactElement> {
  const { ws, id } = await params;
  const sp = await searchParams;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  let formTitle = "Form";
  try {
    formTitle = (await getFormDetail(ws, id)).form.title;
  } catch {
    notFound();
  }
  const status = typeof sp.status === "string" && isSubmissionStatus(sp.status) ? sp.status : undefined;
  const q = typeof sp.q === "string" && sp.q.trim() !== "" ? sp.q.trim().slice(0, 200) : undefined;
  const from = typeof sp.from === "string" && sp.from !== "" ? sp.from : undefined;
  const to = typeof sp.to === "string" && sp.to !== "" ? sp.to : undefined;
  const cursor = typeof sp.cursor === "string" && sp.cursor !== "" ? sp.cursor : undefined;
  const filters = {
    ...(status !== undefined ? { status } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
  let page;
  try {
    page = await listSubmissions({
      workspaceId: ws,
      formId: id,
      filters,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 20,
    });
  } catch {
    notFound();
  }
  const tasks = await getTasksForSubmissions(
    ws,
    page.rows.map((r) => r.id),
  ).catch(() => new Map());

  return (
    <div>
      <p>
        <Link href={`/app/${ws}/forms/${id}`}>← {formTitle}</Link>
      </p>
      <h1>Submissions</h1>
      <p className="muted">
        {page.total} response{page.total === 1 ? "" : "s"}
      </p>
      <SubmissionFilters
        current={{
          ...(status !== undefined ? { status } : {}),
          ...(q !== undefined ? { q } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        }}
      />
      {page.rows.length === 0 ? (
        <div className="card" role="status">
          <p>No submissions match.</p>
          <p className="muted">
            {q !== undefined || status !== undefined
              ? "Try clearing the search or filters."
              : "Share the public form link to collect responses."}
          </p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {page.rows.map((row) => (
            <li key={row.id} className="card">
              <div className="row">
                <div>
                  <strong>{row.summary.primary}</strong>
                  {row.summary.secondary !== null ? <span className="muted"> · {row.summary.secondary}</span> : null}
                  <br />
                  <span className="muted">{formatTimestamp(row.submittedAt)}</span>{" "}
                  <span className="badge">{row.status}</span>{" "}
                  {tasks.get(row.id) !== undefined ? (
                    <span className="badge">
                      {tasks.get(row.id)?.status === "completed"
                        ? tasks.get(row.id)?.outcome
                        : tasks.get(row.id)?.status === "claimed"
                          ? "in review"
                          : "awaiting approval"}
                    </span>
                  ) : null}{" "}
                  {row.publishedVersionNo !== null ? (
                    <span className="muted">v{row.publishedVersionNo}</span>
                  ) : null}
                </div>
                <Link href={`/app/${ws}/forms/${id}/submissions/${row.id}`}>View →</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor !== null ? (
        <p>
          <Link
            href={`/app/${ws}/forms/${id}/submissions?${new URLSearchParams({
              ...(status !== undefined ? { status } : {}),
              ...(q !== undefined ? { q } : {}),
              ...(from !== undefined ? { from } : {}),
              ...(to !== undefined ? { to } : {}),
              cursor: page.nextCursor,
            }).toString()}`}
          >
            Older responses →
          </Link>
        </p>
      ) : null}
    </div>
  );
}
