"use server";
import "server-only";
import { uuidv7 } from "@formos/database";
import { can, DomainError } from "@formos/domain";
import {
  hashCanonical,
  parseCanonicalForm,
  type CanonicalForm,
} from "@formos/forms-engine";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { writeAudit } from "./audit";
import { getMembership, requireUser } from "./identity";
import { supabaseServer } from "./supabaseServer";

/**
 * Secure server-side form CRUD (Phase 4). All authority flows from the
 * session + workspace membership + domain matrix; the client supplies only
 * locator ids (workspace/form), display fields, the expected draft revision,
 * and the candidate canonical document — every one re-verified here.
 *
 * Publish rides on the `form`/`update` grant (builder floor): no new domain
 * permission was needed. Canonical validation runs here (TypeScript) before
 * any persistence; numbering/immutability are enforced in the database.
 */

const KEY_RE = /^[a-z0-9_]{1,64}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;

function fail(message: string, code: "forbidden" | "not_found" = "forbidden"): never {
  throw new DomainError({ code, message });
}

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return base || "form";
}

interface FormRow {
  id: string;
  workspace_id: string;
  key: string;
  title: string;
  description: string | null;
  status: string;
  schema_version: number;
  draft_revision: number;
  draft_payload: unknown;
  created_by: string | null;
  updated_by: string | null;
}

function toConflict(message: string, details?: Record<string, string | number | boolean | null>): never {
  if (details === undefined) throw new DomainError({ code: "conflict", message });
  throw new DomainError({ code: "conflict", message, details });
}

/** Parse + migrate + validate a candidate document; never persists raw JSON. */
function parseDocument(rawJson: string, formId: string, key: string): CanonicalForm {
  if (Buffer.byteLength(rawJson, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new DomainError({ code: "validation_failed", message: "Form document exceeds the 512KB limit." });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson) as unknown;
  } catch {
    throw new DomainError({ code: "validation_failed", message: "Form document is not valid JSON." });
  }
  if (typeof raw !== "object" || raw === null) {
    throw new DomainError({ code: "validation_failed", message: "Form document must be an object." });
  }
  const stamped = { ...(raw as Record<string, unknown>), id: formId, key };
  try {
    return parseCanonicalForm(stamped);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid form document.";
    throw new DomainError({ code: "validation_failed", message });
  }
}

async function loadForm(workspaceId: string, formId: string): Promise<FormRow> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("forms")
    .select("id, workspace_id, key, title, description, status, schema_version, draft_revision, draft_payload, created_by, updated_by")
    .eq("workspace_id", workspaceId)
    .eq("id", formId)
    .maybeSingle();
  if (error || !data) fail("Form not found.", "not_found");
  return data as FormRow;
}

export async function createFormAction(input: {
  workspaceId: string;
  title: string;
  key?: string;
  description?: string;
  documentJson: string;
}): Promise<void> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "create")) {
    fail("Not authorized to create forms.");
  }
  const title = input.title.trim();
  if (!title || title.length > 200) {
    throw new DomainError({ code: "validation_failed", message: "Title is required (max 200 chars)." });
  }
  const rawKey = (input.key ?? "").trim();
  const key = rawKey === "" ? slugify(title) : rawKey;
  if (!KEY_RE.test(key)) {
    throw new DomainError({ code: "validation_failed", message: "Key must match [a-z0-9_]{1,64}." });
  }
  const formId = uuidv7();
  const doc = parseDocument(input.documentJson, formId, key);
  const supabase = await supabaseServer();
  // Plan quota (single entitlement boundary; state-based, no usage row).
  const { data: quota, error: quotaError } = await supabase.rpc("check_quota_member", {
    p_workspace_id: membership.workspaceId,
    p_metric: "active_forms",
    p_quantity: 1,
  });
  if (quotaError) throw new DomainError({ code: "internal", message: "Could not evaluate quota." });
  if ((quota as { allowed?: boolean } | null)?.allowed !== true) {
    throw new DomainError({ code: "plan_limit", message: "Form limit reached for your workspace plan." });
  }
  const { error } = await supabase.from("forms").insert({
    id: formId,
    workspace_id: membership.workspaceId,
    key: doc.key,
    title,
    description: (input.description ?? "").trim() || null,
    status: "active",
    schema_version: doc.schemaVersion,
    draft_revision: 1,
    draft_payload: doc,
    created_by: user.id,
    updated_by: user.id,
  });
  if (error) {
    if (/duplicate|unique/i.test(error.message)) toConflict("A form with this key already exists in the workspace.");
    throw new DomainError({ code: "internal", message: "Could not create the form." });
  }
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "form.created",
    resourceType: "form",
    resourceId: formId,
    diff: { key: doc.key, schemaVersion: doc.schemaVersion },
  });
  revalidatePath(`/app/${membership.workspaceId}/forms`);
  redirect(`/app/${membership.workspaceId}/forms/${formId}`);
}

export interface DraftConflict {
  ok: false;
  conflict: true;
  expectedRevision: number;
  currentRevision: number;
}

export async function updateDraftAction(input: {
  workspaceId: string;
  formId: string;
  expectedRevision: number;
  title?: string;
  key?: string;
  description?: string;
  status?: "active" | "archived";
  documentJson?: string;
}): Promise<{ ok: true; revision: number } | DraftConflict> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "update")) {
    fail("Not authorized to edit forms.");
  }
  const row = await loadForm(membership.workspaceId, input.formId);
  if (row.draft_revision !== input.expectedRevision) {
    // Conflict: the client's base is stale. State is preserved client-side;
    // the caller surfaces currentRevision so the builder can reload/merge.
    return { ok: false, conflict: true, expectedRevision: input.expectedRevision, currentRevision: row.draft_revision };
  }
  const patch: Record<string, unknown> = { updated_by: user.id };
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > 200) throw new DomainError({ code: "validation_failed", message: "Title is required (max 200 chars)." });
    patch["title"] = title;
  }
  if (input.key !== undefined) {
    const key = input.key.trim();
    if (!KEY_RE.test(key)) throw new DomainError({ code: "validation_failed", message: "Key must match [a-z0-9_]{1,64}." });
    patch["key"] = key;
  }
  if (input.description !== undefined) patch["description"] = input.description.trim() || null;
  if (input.status !== undefined) patch["status"] = input.status;
  if (input.documentJson !== undefined) {
    const doc = parseDocument(input.documentJson, row.id, (patch["key"] as string | undefined) ?? row.key);
    patch["draft_payload"] = doc;
    patch["schema_version"] = doc.schemaVersion;
  }
  const nextRevision = row.draft_revision + 1;
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("forms")
    .update({ ...patch, draft_revision: nextRevision })
    .eq("id", row.id)
    .eq("draft_revision", row.draft_revision)
    .select("draft_revision");
  if (error) {
    if (/duplicate|unique/i.test(error.message)) toConflict("A form with this key already exists in the workspace.");
    throw new DomainError({ code: "internal", message: "Could not save the draft." });
  }
  if (!data || (data as unknown[]).length === 0) {
    // Lost a concurrent race between the read and the write: same conflict path.
    const current = await loadForm(membership.workspaceId, input.formId);
    return { ok: false, conflict: true, expectedRevision: input.expectedRevision, currentRevision: current.draft_revision };
  }
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "form.updated",
    resourceType: "form",
    resourceId: row.id,
    diff: { revision: nextRevision },
  });
  revalidatePath(`/app/${membership.workspaceId}/forms/${row.id}`);
  return { ok: true, revision: nextRevision };
}

export async function publishAction(input: {
  workspaceId: string;
  formId: string;
  expectedRevision: number;
}): Promise<{ ok: true; publishedVersion: number } | DraftConflict> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  // Publish rides on the form/update grant (builder floor) — no new permission.
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "update")) {
    fail("Not authorized to publish forms.");
  }
  const row = await loadForm(membership.workspaceId, input.formId);
  if (row.status !== "active") throw new DomainError({ code: "validation_failed", message: "Only active forms can be published." });
  if (row.draft_revision !== input.expectedRevision) {
    return { ok: false, conflict: true, expectedRevision: input.expectedRevision, currentRevision: row.draft_revision };
  }
  let doc: CanonicalForm;
  try {
    doc = parseCanonicalForm(row.draft_payload);
  } catch (error) {
    throw new DomainError({ code: "validation_failed", message: error instanceof Error ? error.message : "Stored draft is invalid." });
  }
  const schemaHash = hashCanonical(doc);
  const supabase = await supabaseServer();
  const versionId = uuidv7();
  const { data, error } = await supabase.rpc("publish_form", {
    p_version_id: versionId,
    p_form_id: row.id,
    p_snapshot: doc,
    p_schema_version: doc.schemaVersion,
    p_schema_hash: schemaHash,
    p_renderer_version: doc.rendererVersion,
    p_publisher: user.id,
    p_expected_revision: row.draft_revision,
  });
  if (error) {
    if (/draft conflict/i.test(error.message)) {
      const current = await loadForm(membership.workspaceId, input.formId);
      return { ok: false, conflict: true, expectedRevision: input.expectedRevision, currentRevision: current.draft_revision };
    }
    if (/builder required|not a member|authentication required/i.test(error.message)) fail("Not authorized to publish forms.");
    throw new DomainError({ code: "internal", message: "Could not publish the form." });
  }
  const publishedVersion = data as number;
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "form.published",
    resourceType: "form_version",
    resourceId: versionId,
    diff: { formId: row.id, publishedVersion, schemaHash },
  });
  // Publication availability: repoint the form's stable public identity at
  // the new immutable version (provisions it on first publish). The public
  // route never reads the mutable draft — only this pinned version.
  const { syncPublicationToLatestVersion } = await import("./publications");
  await syncPublicationToLatestVersion({
    workspaceId: membership.workspaceId,
    formId: row.id,
    publishedVersionNo: publishedVersion,
    publisherId: user.id,
  });
  revalidatePath(`/app/${membership.workspaceId}/forms/${row.id}`);
  return { ok: true, publishedVersion };
}

/** Rollback-by-republish: a previous immutable snapshot becomes the draft, then publishes as the next version. */
export async function republishAction(input: {
  workspaceId: string;
  formId: string;
  publishedVersion: number;
  expectedRevision: number;
}): Promise<{ ok: true; publishedVersion: number } | DraftConflict> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "update")) {
    fail("Not authorized to publish forms.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("form_versions")
    .select("schema_snapshot")
    .eq("workspace_id", membership.workspaceId)
    .eq("form_id", input.formId)
    .eq("published_version_no", input.publishedVersion)
    .maybeSingle();
  if (error || !data) fail("Published version not found.", "not_found");
  const snapshot = (data as { schema_snapshot: unknown }).schema_snapshot;
  let doc: CanonicalForm;
  try {
    doc = parseCanonicalForm(snapshot);
  } catch (err) {
    throw new DomainError({ code: "validation_failed", message: err instanceof Error ? err.message : "Snapshot is invalid." });
  }
  // Snapshots never mutate: restore into the draft (OCC-guarded), then publish.
  const restored = await updateDraftAction({
    workspaceId: membership.workspaceId,
    formId: input.formId,
    expectedRevision: input.expectedRevision,
    documentJson: JSON.stringify({ ...doc, id: input.formId }),
  });
  if (!restored.ok) return restored;
  const published = await publishAction({
    workspaceId: membership.workspaceId,
    formId: input.formId,
    expectedRevision: restored.revision,
  });
  return published;
}

export async function deleteFormAction(input: { workspaceId: string; formId: string }): Promise<void> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "delete")) {
    fail("Not authorized to delete forms.");
  }
  const row = await loadForm(membership.workspaceId, input.formId);
  const supabase = await supabaseServer();
  const { error } = await supabase.from("forms").delete().eq("id", row.id);
  if (error) throw new DomainError({ code: "internal", message: "Could not delete the form." });
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "form.deleted",
    resourceType: "form",
    resourceId: row.id,
    diff: { key: row.key },
  });
  revalidatePath(`/app/${membership.workspaceId}/forms`);
  redirect(`/app/${membership.workspaceId}/forms`);
}

export async function listForms(workspaceId: string): Promise<FormRow[]> {
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "read")) {
    fail("Not authorized to view forms.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("forms")
    .select("id, workspace_id, key, title, description, status, schema_version, draft_revision, draft_payload, created_by, updated_by")
    .eq("workspace_id", membership.workspaceId)
    .order("title");
  if (error) throw new DomainError({ code: "internal", message: "Could not list forms." });
  return (data ?? []) as FormRow[];
}

export async function getFormDetail(workspaceId: string, formId: string): Promise<{ form: FormRow; versions: Array<{ id: string; published_version_no: number; schema_hash: string; renderer_version: string; publisher_id: string | null; published_at: string }> }> {
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "read")) {
    fail("Not authorized to view forms.");
  }
  const form = await loadForm(membership.workspaceId, formId);
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("form_versions")
    .select("id, published_version_no, schema_hash, renderer_version, publisher_id, published_at")
    .eq("workspace_id", membership.workspaceId)
    .eq("form_id", formId)
    .order("published_version_no", { ascending: false });
  if (error) throw new DomainError({ code: "internal", message: "Could not list versions." });
  return { form, versions: (data ?? []) as Array<{ id: string; published_version_no: number; schema_hash: string; renderer_version: string; publisher_id: string | null; published_at: string }> };
}

export async function getVersionSnapshot(workspaceId: string, formId: string, publishedVersion: number): Promise<unknown> {
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  if (!can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "form", "read")) {
    fail("Not authorized to view forms.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("form_versions")
    .select("schema_snapshot")
    .eq("workspace_id", membership.workspaceId)
    .eq("form_id", formId)
    .eq("published_version_no", publishedVersion)
    .maybeSingle();
  if (error || !data) fail("Published version not found.", "not_found");
  return (data as { schema_snapshot: unknown }).schema_snapshot;
}
