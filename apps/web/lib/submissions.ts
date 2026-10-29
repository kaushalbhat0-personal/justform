"use server";
import "server-only";
import { uuidv7 } from "@formos/database";
import { can, DomainError, type WorkspaceRole } from "@formos/domain";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";
import { revalidatePath } from "next/cache";
import { writeAudit } from "./audit";
import { getMembership, requireUser } from "./identity";
import {
  isSubmissionStatus,
  type SubmissionFilters,
  type SubmissionListItem,
  type SubmissionPage,
  type SubmissionRow,
  type SubmissionStatus,
} from "./submissions/types";
import {
  buildSearchOr,
  clampLimit,
  decodeCursor,
  encodeCursor,
  keysetOr,
  neighborOr,
  NIL_UUID,
  UUID_RE,
} from "./submissions/query";
import { summarizeSubmission, textSearchKeys } from "./submissions/present";
import { supabaseServer } from "./supabaseServer";

/**
 * Authenticated submission repository (Phase 7).
 * Every operation resolves session → membership → resource ownership.
 * Reads: direct RLS-gated SELECTs (builder+ per frozen matrix).
 * Mutations: SECURITY DEFINER RPC only (update floor = data_collaborator).
 * Payloads are never logged, never audited, never placed in URLs.
 */

const MAX_VERSION_SNAPSHOTS = 20;

function fail(message: string, code: "forbidden" | "not_found" = "forbidden"): never {
  throw new DomainError({ code, message });
}

interface Caller { userId: string; workspaceId: string; role: WorkspaceRole; }

async function requireCaller(workspaceId: string): Promise<Caller> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  return { userId: user.id, workspaceId: membership.workspaceId, role: membership.role };
}

/** Confirm the form belongs to the caller's workspace (never trust URL ids alone). */
async function requireOwnedForm(workspaceId: string, formId: string): Promise<{ id: string; title: string }> {
  if (!UUID_RE.test(formId)) fail("Submission not found.", "not_found");
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("forms")
    .select("id, title")
    .eq("workspace_id", workspaceId)
    .eq("id", formId)
    .maybeSingle();
  if (error || !data) fail("Submission not found.", "not_found");
  return data as { id: string; title: string };
}

function toRow(raw: Record<string, unknown>): SubmissionRow {
  return {
    id: raw["id"] as string,
    workspaceId: raw["workspace_id"] as string,
    formId: raw["form_id"] as string,
    publicationId: raw["publication_id"] as string,
    formVersionId: raw["form_version_id"] as string,
    status: raw["status"] as SubmissionStatus,
    submittedAt: raw["submitted_at"] as string,
    statusChangedAt: raw["status_changed_at"] as string,
    payload: (raw["payload"] as Record<string, unknown>) ?? {},
  };
}

interface VersionInfo {
  id: string;
  publishedVersionNo: number;
  snapshot: CanonicalForm | null;
}

/** Pinned snapshots for column derivation (batched; caller passes version ids). */
export async function getPinnedSnapshots(input: {
  workspaceId: string;
  formId: string;
  versionIds: string[];
}): Promise<Array<{ id: string; publishedVersionNo: number; snapshot: CanonicalForm | null }>> {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "submission", "read")) {
    fail("Not authorized to view submissions.");
  }
  await requireOwnedForm(caller.workspaceId, input.formId);
  const map = await fetchVersionSnapshots(caller.workspaceId, input.formId, input.versionIds);
  return [...map.values()];
}

async function fetchVersionSnapshots(
  workspaceId: string,
  formId: string,
  versionIds: string[],
): Promise<Map<string, VersionInfo>> {
  const map = new Map<string, VersionInfo>();
  const ids = [...new Set(versionIds)].slice(0, MAX_VERSION_SNAPSHOTS);
  if (ids.length === 0) return map;
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("form_versions")
    .select("id, published_version_no, schema_snapshot")
    .eq("workspace_id", workspaceId)
    .eq("form_id", formId)
    .in("id", ids);
  if (error) throw new DomainError({ code: "internal", message: "Could not load form versions." });
  for (const row of (data ?? []) as Array<{ id: string; published_version_no: number; schema_snapshot: unknown }>) {
    let snapshot: CanonicalForm | null = null;
    try {
      snapshot = parseCanonicalForm(row.schema_snapshot);
    } catch {
      snapshot = null;
    }
    map.set(row.id, { id: row.id, publishedVersionNo: row.published_version_no, snapshot });
  }
  return map;
}

export interface ListInput {
  workspaceId: string;
  formId: string;
  filters?: SubmissionFilters;
  cursor?: string;
  limit?: number;
}

/** Paginated, filterable inbox list. Page rows carry per-row pinned-version summaries. */
export async function listSubmissions(input: ListInput): Promise<SubmissionPage> {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "submission", "read")) {
    fail("Not authorized to view submissions.");
  }
  await requireOwnedForm(caller.workspaceId, input.formId);
  const filters = input.filters ?? {};
  if (filters.status !== undefined && !isSubmissionStatus(filters.status)) {
    fail("Submission not found.", "not_found");
  }
  const limit = clampLimit(input.limit);
  const supabase = await supabaseServer();

  // Snapshot-derived search keys (union across recent versions so historical
  // text fields stay searchable; bounded, no search engine).
  let searchKeys: string[] = [];
  if (filters.q !== undefined && filters.q.trim() !== "") {
    const { data: versions } = await supabase
      .from("form_versions")
      .select("id")
      .eq("workspace_id", caller.workspaceId)
      .eq("form_id", input.formId)
      .order("published_version_no", { ascending: false })
      .limit(MAX_VERSION_SNAPSHOTS);
    const snaps = await fetchVersionSnapshots(
      caller.workspaceId,
      input.formId,
      ((versions ?? []) as Array<{ id: string }>).map((v) => v.id),
    );
    const keys = new Set<string>();
    for (const info of snaps.values()) {
      if (info.snapshot) for (const k of textSearchKeys(info.snapshot)) keys.add(k);
    }
    searchKeys = [...keys];
  }

  let query = supabase
    .from("submissions")
    .select("id, workspace_id, form_id, publication_id, form_version_id, status, submitted_at, status_changed_at, payload", { count: "exact" })
    .eq("workspace_id", caller.workspaceId)
    .eq("form_id", input.formId);
  if (filters.status !== undefined) query = query.eq("status", filters.status);
  if (filters.from !== undefined && filters.from !== "") query = query.gte("submitted_at", filters.from);
  if (filters.to !== undefined && filters.to !== "") query = query.lt("submitted_at", filters.to);
  const q = filters.q?.trim() ?? "";
  if (q !== "") {
    const orExpr = buildSearchOr(q, searchKeys);
    // No searchable surface (no text keys and not a UUID): force empty page.
    query = orExpr !== null ? query.or(orExpr) : query.eq("id", NIL_UUID);
  }
  if (input.cursor !== undefined) {
    const { t, id } = decodeCursor(input.cursor);
    query = query.or(keysetOr(t, id));
  }
  const { data, error, count } = await query
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new DomainError({ code: "internal", message: "Could not list submissions." });

  const rawRows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const snaps = await fetchVersionSnapshots(
    caller.workspaceId,
    input.formId,
    pageRows.map((r) => r["form_version_id"] as string),
  );
  const rows: SubmissionListItem[] = pageRows.map((raw) => {
    const row = toRow(raw);
    const info = snaps.get(row.formVersionId);
    const summary =
      info?.snapshot != null
        ? summarizeSubmission(info.snapshot, row.payload)
        : { primary: "Submission", secondary: null };
    return { ...row, summary, publishedVersionNo: info?.publishedVersionNo ?? null };
  });
  const last = pageRows[pageRows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last["submitted_at"] as string, last["id"] as string) : null,
    total: count ?? rows.length,
  };
}

export interface SubmissionDetail {
  row: SubmissionRow;
  snapshot: CanonicalForm;
  publishedVersionNo: number;
  prevId: string | null;
  nextId: string | null;
}

/** Single submission rendered through its pinned immutable snapshot. */
export async function getSubmissionDetail(input: {
  workspaceId: string;
  formId: string;
  submissionId: string;
  statusFilter?: SubmissionStatus;
}): Promise<SubmissionDetail> {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "submission", "read")) {
    fail("Not authorized to view submissions.");
  }
  if (!UUID_RE.test(input.submissionId)) fail("Submission not found.", "not_found");
  await requireOwnedForm(caller.workspaceId, input.formId);
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("submissions")
    .select("id, workspace_id, form_id, publication_id, form_version_id, status, submitted_at, status_changed_at, payload")
    .eq("workspace_id", caller.workspaceId)
    .eq("form_id", input.formId)
    .eq("id", input.submissionId)
    .maybeSingle();
  if (error || !data) fail("Submission not found.", "not_found");
  const row = toRow(data as Record<string, unknown>);

  const snaps = await fetchVersionSnapshots(caller.workspaceId, input.formId, [row.formVersionId]);
  const info = snaps.get(row.formVersionId);
  if (!info?.snapshot) fail("Submission not found.", "not_found");
  const snapshot = info.snapshot;

  // Chronological neighbors (same status scope when the list was filtered).
  const scope = (() => {
    let q = supabase.from("submissions").select("id").eq("workspace_id", caller.workspaceId).eq("form_id", input.formId);
    if (input.statusFilter !== undefined) q = q.eq("status", input.statusFilter);
    return q;
  })();
  const older = await scope
    .or(neighborOr("older", row.submittedAt, row.id))
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  const newer = await scope
    .or(neighborOr("newer", row.submittedAt, row.id))
    .order("submitted_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  const nextId = ((older.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  const prevId = ((newer.data ?? []) as Array<{ id: string }>)[0]?.id ?? null;

  // First open marks new → read (audited metadata change, never payload).
  if (row.status === "new") {
    const { error: rpcError } = await supabase.rpc("set_submission_status", {
      p_submission_id: row.id,
      p_status: "read",
      p_event_id: uuidv7(),
    });
    if (!rpcError) {
      row.status = "read";
      await writeAudit({
        workspaceId: caller.workspaceId,
        actorId: caller.userId,
        actorType: "user",
        action: "submission.status_changed",
        resourceType: "submission",
        resourceId: row.id,
        diff: { from: "new", to: "read" },
      }).catch(() => undefined);
    }
  }

  return { row, snapshot, publishedVersionNo: info.publishedVersionNo, prevId, nextId };
}

/** Status mutation (archive / unarchive / mark read). Update floor = data_collaborator. */
export async function setSubmissionStatusAction(input: {
  workspaceId: string;
  formId: string;
  submissionId: string;
  status: SubmissionStatus;
}): Promise<{ ok: true; status: SubmissionStatus; previous: SubmissionStatus; changed: boolean }> {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "submission", "update")) {
    fail("Not authorized to update submissions.");
  }
  if (!UUID_RE.test(input.submissionId) || !isSubmissionStatus(input.status)) {
    fail("Submission not found.", "not_found");
  }
  await requireOwnedForm(caller.workspaceId, input.formId);
  const supabase = await supabaseServer();
  // Defense in depth: the row must belong to this form (RLS + RPC re-verify).
  const { data: existing } = await supabase
    .from("submissions")
    .select("id, status")
    .eq("workspace_id", caller.workspaceId)
    .eq("form_id", input.formId)
    .eq("id", input.submissionId)
    .maybeSingle();
  // Data collaborators hold no SELECT grant: fall back to the RPC receipt for
  // the audit diff instead of failing the membership-proven update.
  const { data, error } = await supabase.rpc("set_submission_status", {
    p_submission_id: input.submissionId,
    p_status: input.status,
    p_event_id: uuidv7(),
  });
  if (error) {
    if (/not found/i.test(error.message)) fail("Submission not found.", "not_found");
    if (/forbidden/i.test(error.message)) fail("Not authorized to update submissions.");
    throw new DomainError({ code: "internal", message: "Could not update the submission." });
  }
  const receipt = data as { id: string; status: SubmissionStatus; previous: SubmissionStatus; changed: boolean };
  if (receipt.changed) {
    await writeAudit({
      workspaceId: caller.workspaceId,
      actorId: caller.userId,
      actorType: "user",
      action: "submission.status_changed",
      resourceType: "submission",
      resourceId: input.submissionId,
      diff: {
        from: (existing as { status: string } | null)?.status ?? receipt.previous,
        to: receipt.status,
      },
    });
  }
  revalidatePath(`/app/${caller.workspaceId}/forms/${input.formId}/submissions`);
  return { ok: true, status: receipt.status, previous: receipt.previous, changed: receipt.changed };
}
