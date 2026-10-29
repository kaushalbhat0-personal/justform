import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@formos/domain";
import { getMembership } from "@/lib/identity";
import { getFormDetail, getVersionSnapshot } from "@/lib/forms";
import { getPublication } from "@/lib/publications";
import { serverEnv } from "@/lib/env";
import { FormDetailClient } from "./_components/FormDetailClient";
import { PublicationPanel } from "./_components/PublicationPanel";
import { WorkflowPanel } from "./_components/WorkflowPanel";
import { getWorkflowForForm } from "@/lib/workflows";

/** Form detail: draft editing, publish, versions, republish (lifecycle proof). */
export default async function FormDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string; id: string }>;
  searchParams: Promise<{ v?: string }>;
}): Promise<React.ReactElement> {
  const { ws, id } = await params;
  const { v } = await searchParams;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  let detail;
  try {
    detail = await getFormDetail(ws, id);
  } catch {
    notFound();
  }
  const { form, versions } = detail;
  const selectedVersion = v === undefined ? null : Number(v);
  const snapshot =
    selectedVersion !== null && Number.isInteger(selectedVersion)
      ? await getVersionSnapshot(ws, id, selectedVersion).catch(() => null)
      : null;
  const publication = await getPublication(ws, id).catch(() => null);
  const workflowDef = await getWorkflowForForm(ws, id).catch(() => null);
  const publicUrl =
    publication === null ? null : `${serverEnv().APP_URL.replace(/\/$/, "")}/f/${publication.publicId}`;

  return (
    <div>
      <p>
        <Link href={`/app/${ws}/forms`}>← Forms</Link>
      </p>
      <h1>{form.title}</h1>
      <p className="muted">
        key {form.key} · rev {form.draft_revision} · {form.status} · schema v{form.schema_version}
      </p>
      <p>
        <Link href={`/app/${ws}/forms/${id}/builder`}>Open in builder</Link>
      </p>
      <FormDetailClient
        workspaceId={ws}
        formId={form.id}
        revision={form.draft_revision}
        initial={{
          title: form.title,
          key: form.key,
          description: form.description ?? "",
          status: form.status,
          documentJson: JSON.stringify(form.draft_payload, null, 2),
        }}
        versions={versions.map((ver) => ({ published_version_no: ver.published_version_no }))}
      />
      {selectedVersion !== null && (
        <div>
          <h2>Published version {selectedVersion} (immutable snapshot)</h2>
          <pre>{JSON.stringify(snapshot, null, 2)}</pre>
        </div>
      )}
      <PublicationPanel
        workspaceId={ws}
        formId={form.id}
        publicId={publication?.publicId ?? null}
        publicUrl={publicUrl}
        isActive={publication?.isActive ?? false}
        publishedVersionNo={publication?.publishedVersionNo ?? null}
      />
      <WorkflowPanel
        workspaceId={ws}
        formId={form.id}
        definition={
          workflowDef === null
            ? null
            : { id: workflowDef.id, status: workflowDef.status, currentVersionId: workflowDef.currentVersionId }
        }
        canManage={can(
          { userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] },
          "workflow",
          "update",
        )}
        canArchive={can(
          { userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] },
          "workflow",
          "delete",
        )}
      />
      {can(
        { userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] },
        "submission",
        "read",
      ) ? (
        <p>
          <Link href={`/app/${ws}/forms/${id}/submissions`}>View submissions →</Link>{" "}
          <Link href={`/app/${ws}/forms/${id}/tables`}>View table →</Link>
        </p>
      ) : null}
      <h2>Version history</h2>
      {versions.length === 0 ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <ul>
          {versions.map((ver) => (
            <li key={ver.id}>
              version {ver.published_version_no} · hash {ver.schema_hash.slice(0, 12)}… · {ver.published_at}
            </li>
          ))}
        </ul>
      )}
      <h2>Danger zone</h2>
      <form
        action={async () => {
          "use server";
          const { deleteFormAction: remove } = await import("@/lib/forms");
          await remove({ workspaceId: ws, formId: id });
        }}
      >
        <button type="submit">Delete form</button>
      </form>
    </div>
  );
}
