"use server";
import "server-only";
import { uuidv7 } from "@formos/database";
import { can, DomainError } from "@formos/domain";
import { revalidatePath } from "next/cache";
import { writeAudit } from "./audit";
import { getMembership, requireUser } from "./identity";
import { generatePublicId } from "./public/publicIds";
import { supabaseServer } from "./supabaseServer";

/**
 * Publication lifecycle (Phase 6). One stable unguessable public identity per
 * form, repointed on every publish — the public route resolves the entire
 * authority chain (workspace/form/version) from this row, never from caller
 * input. Builder floor rides on the form/update grant (publish parity).
 */

export interface PublicationInfo {
  id: string;
  publicId: string;
  isActive: boolean;
  formVersionId: string;
  publishedVersionNo: number | null;
  opensAt: string | null;
  closesAt: string | null;
  maxSubmissions: number | null;
}

/** Re-exported for existing importers (canonical home is ./public/publicIds). */
export { generatePublicId };

function fail(message: string, code: "forbidden" | "not_found" = "forbidden"): never {
  throw new DomainError({ code, message });
}

async function requireBuilder(workspaceId: string): Promise<{ userId: string; workspaceId: string }> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "update")) {
    fail("Not authorized to manage publications.");
  }
  return { userId: user.id, workspaceId: membership.workspaceId };
}

async function readPublication(workspaceId: string, formId: string): Promise<PublicationInfo | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("form_publications")
    .select("id, public_id, is_active, form_version_id, opens_at, closes_at, max_submissions")
    .eq("workspace_id", workspaceId)
    .eq("form_id", formId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    id: string;
    public_id: string;
    is_active: boolean;
    form_version_id: string;
    opens_at: string | null;
    closes_at: string | null;
    max_submissions: number | null;
  };
  let publishedVersionNo: number | null = null;
  const { data: ver } = await supabase
    .from("form_versions")
    .select("published_version_no")
    .eq("id", row.form_version_id)
    .maybeSingle();
  if (ver) publishedVersionNo = (ver as { published_version_no: number }).published_version_no;
  return {
    id: row.id,
    publicId: row.public_id,
    isActive: row.is_active,
    formVersionId: row.form_version_id,
    publishedVersionNo,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    maxSubmissions: row.max_submissions,
  };
}

/** Builder-visible publication (read grant suffices — mirrors getFormDetail). */
export async function getPublication(workspaceId: string, formId: string): Promise<PublicationInfo | null> {
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "read")) {
    fail("Not authorized to view publications.");
  }
  return readPublication(membership.workspaceId, formId);
}

/**
 * Repoint the form's publication at a published version (called by
 * publishAction after every successful publish; idempotent provisioning for
 * older forms). Concurrent publishers race on UNIQUE(form_id) — the loser
 * falls back to updating the winner's row.
 */
export async function syncPublicationToLatestVersion(input: {
  workspaceId: string;
  formId: string;
  publishedVersionNo: number;
  publisherId: string;
}): Promise<PublicationInfo> {
  const { workspaceId } = await requireBuilder(input.workspaceId);
  const supabase = await supabaseServer();
  const { data: version, error: versionError } = await supabase
    .from("form_versions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("form_id", input.formId)
    .eq("published_version_no", input.publishedVersionNo)
    .maybeSingle();
  if (versionError || !version) fail("Published version not found.", "not_found");
  const versionId = (version as { id: string }).id;
  const existing = await readPublication(workspaceId, input.formId);
  if (existing) {
    const { error } = await supabase
      .from("form_publications")
      .update({ form_version_id: versionId })
      .eq("id", existing.id);
    if (error) throw new DomainError({ code: "internal", message: "Could not update the publication." });
    revalidatePath(`/app/${workspaceId}/forms/${input.formId}`);
    return { ...existing, formVersionId: versionId, publishedVersionNo: input.publishedVersionNo };
  }
  const id = uuidv7();
  const publicId = generatePublicId();
  const { error } = await supabase.from("form_publications").insert({
    id,
    workspace_id: workspaceId,
    form_id: input.formId,
    form_version_id: versionId,
    public_id: publicId,
    is_active: true,
    created_by: input.publisherId,
  });
  if (error) {
    // Lost the insert race: another publisher provisioned it — update instead.
    if (/duplicate|unique/i.test(error.message)) {
      const winner = await readPublication(workspaceId, input.formId);
      if (!winner) throw new DomainError({ code: "internal", message: "Could not update the publication." });
      const { error: updateError } = await supabase
        .from("form_publications")
        .update({ form_version_id: versionId })
        .eq("id", winner.id);
      if (updateError) throw new DomainError({ code: "internal", message: "Could not update the publication." });
      revalidatePath(`/app/${workspaceId}/forms/${input.formId}`);
      return { ...winner, formVersionId: versionId, publishedVersionNo: input.publishedVersionNo };
    }
    throw new DomainError({ code: "internal", message: "Could not create the publication." });
  }
  revalidatePath(`/app/${workspaceId}/forms/${input.formId}`);
  return {
    id,
    publicId,
    isActive: true,
    formVersionId: versionId,
    publishedVersionNo: input.publishedVersionNo,
    opensAt: null,
    closesAt: null,
    maxSubmissions: null,
  };
}

/** Activate/deactivate the public URL (archive = unpublish, no history mutated). */
export async function setPublicationActiveAction(input: {
  workspaceId: string;
  formId: string;
  isActive: boolean;
}): Promise<{ ok: true; isActive: boolean }> {
  const { userId, workspaceId } = await requireBuilder(input.workspaceId);
  const existing = await readPublication(workspaceId, input.formId);
  if (!existing) fail("No publication exists for this form.", "not_found");
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("form_publications")
    .update({ is_active: input.isActive })
    .eq("id", (existing as PublicationInfo).id);
  if (error) throw new DomainError({ code: "internal", message: "Could not update the publication." });
  await writeAudit({
    workspaceId,
    actorId: userId,
    actorType: "user",
    action: input.isActive ? "form.published" : "form.unpublished",
    resourceType: "form_publication",
    resourceId: (existing as PublicationInfo).id,
    diff: { formId: input.formId, publicId: (existing as PublicationInfo).publicId, isActive: input.isActive },
  });
  revalidatePath(`/app/${workspaceId}/forms/${input.formId}`);
  return { ok: true, isActive: input.isActive };
}
