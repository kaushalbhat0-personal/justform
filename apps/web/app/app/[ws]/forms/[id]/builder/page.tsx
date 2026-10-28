import { notFound } from "next/navigation";
import { getMembership } from "@/lib/identity";
import { getFormDetail } from "@/lib/forms";
import { BuilderShell } from "./_components/BuilderShell";

/** Builder foundation route: loads the draft through the read grant, hands off to the client shell. */
export default async function BuilderPage({ params }: { params: Promise<{ ws: string; id: string }> }): Promise<React.ReactElement> {
  const { ws, id } = await params;
  const membership = await getMembership(ws);
  if (!membership) notFound();
  let detail;
  try {
    detail = await getFormDetail(ws, id);
  } catch {
    notFound();
  }
  return (
    <BuilderShell
      workspaceId={ws}
      formId={id}
      role={membership.role}
      canEdit={membership.role === "owner" || membership.role === "admin" || membership.role === "builder"}
      initialDoc={detail.form.draft_payload}
      initialRevision={detail.form.draft_revision}
      initialVersions={detail.versions.map((v) => ({
        published_version_no: v.published_version_no,
        schema_hash: v.schema_hash,
        published_at: v.published_at,
      }))}
    />
  );
}
