import Link from "next/link";
import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { getFormDetail } from "@/lib/forms";
import { getPinnedSnapshots, listSubmissions } from "@/lib/submissions";
import { formatTimestamp } from "@/lib/submissions/present";
import { isSubmissionStatus } from "@/lib/submissions/types";
import { deriveColumns, fieldIndex, renderTableCell, type TableColumn } from "@/lib/tables/columns";
import type { CanonicalForm } from "@formos/forms-engine";
import { SubmissionFilters } from "../submissions/_components/SubmissionFilters";

/** Workspace form Tables view: tabular, server-paginated, pinned-version rendering. */
export default async function TablesPage({
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
  let page;
  try {
    page = await listSubmissions({
      workspaceId: ws,
      formId: id,
      filters: {
        ...(status !== undefined ? { status } : {}),
        ...(q !== undefined ? { q } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      },
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 20,
    });
  } catch {
    notFound();
  }

  // Pinned snapshots for every version on this page (single batched fetch,
  // never per-row). Columns derive from these; cells render per-row pinned.
  const versionIds = [...new Set(page.rows.map((r) => r.formVersionId))];
  const pinned = await getPinnedSnapshots({ workspaceId: ws, formId: id, versionIds }).catch(() => []);
  const withSnapshot = pinned.filter((v) => v.snapshot !== null) as Array<{
    id: string;
    publishedVersionNo: number;
    snapshot: CanonicalForm;
  }>;
  const columns: TableColumn[] = deriveColumns(withSnapshot);
  const fieldsByVersion = new Map(withSnapshot.map((v) => [v.id, fieldIndex(v.snapshot)]));

  const baseQuery = {
    ...(status !== undefined ? { status } : {}),
    ...(q !== undefined ? { q } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };

  return (
    <div>
      <p>
        <Link href={`/app/${ws}/forms/${id}`}>← {formTitle}</Link>
      </p>
      <h1>Responses table</h1>
      <p className="muted">
        {page.total} response{page.total === 1 ? "" : "s"} · columns follow the latest published schema; values
        render from each row&apos;s pinned version
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
        <div
          className="card"
          role="region"
          aria-label="Submissions table, scrollable"
          tabIndex={0}
          style={{ overflowX: "auto", padding: 0 }}
        >
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "640px" }}>
            <caption className="muted" style={{ textAlign: "left", padding: "12px" }}>
              {page.rows.length} of {page.total} responses · columns: latest published schema order · values: pinned
              version per row
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>ID</th>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>Submitted</th>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>Status</th>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>Version</th>
                {columns.map((col) => (
                  <th key={col.key} scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>
                    {col.label}
                  </th>
                ))}
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>
                  <span className="muted">Detail</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const fields = fieldsByVersion.get(row.formVersionId);
                return (
                  <tr key={row.id}>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <Link href={`/app/${ws}/forms/${id}/submissions/${row.id}`} aria-label={`Open submission ${row.id}`}>
                        {row.id.slice(0, 8)}…
                      </Link>
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{formatTimestamp(row.submittedAt)}</td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <span className="badge">{row.status}</span>
                    </td>
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      {row.publishedVersionNo !== null ? `v${row.publishedVersionNo}` : <span className="muted">—</span>}
                    </td>
                    {columns.map((col) => {
                      const cell = renderTableCell(fields?.get(col.key), row.payload[col.key]);
                      return (
                        <td key={col.key} style={{ padding: "8px 12px", maxWidth: "280px" }} title={cell.title}>
                          {cell.href !== undefined ? (
                            <a href={cell.href}>{cell.text}</a>
                          ) : cell.muted ? (
                            <span className="muted">{cell.text}</span>
                          ) : (
                            cell.text
                          )}
                        </td>
                      );
                    })}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <Link href={`/app/${ws}/forms/${id}/submissions/${row.id}`}>Open →</Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor !== null ? (
        <p>
          <Link
            href={`/app/${ws}/forms/${id}/tables?${new URLSearchParams({
              ...baseQuery,
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
