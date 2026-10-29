import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";
import { isSubmissionStatus, type SubmissionFilters, type SubmissionStatus } from "../submissions/types";
import { buildSearchOr, clampLimit, decodeCursor, encodeCursor, keysetOr, UUID_RE } from "../submissions/query";
import { renderValue, textSearchKeys } from "../submissions/present";
import { ApiError } from "./envelope";

/**
 * Versioned public API read model (Phase 9).
 * Every query carries an explicit workspace_id equality derived from the
 * verified API key binding — never from caller input beyond the auth step.
 * No mutations exist in this API version.
 */

export interface ApiFormVersion {
  version_no: number;
  schema_version: number;
  schema_hash: string;
  renderer_version: string;
  published_at: string;
}

export interface ApiForm {
  id: string;
  key: string;
  title: string;
  description: string | null;
  status: string;
  updated_at: string;
  published_version: ApiFormVersion | null;
}

export interface ApiSubmissionField {
  key: string;
  label: string;
  type: string;
  value: unknown;
  display: string;
  href?: string;
}

export interface ApiSubmission {
  id: string;
  form_id: string;
  status: SubmissionStatus;
  submitted_at: string;
  published_version: { version_no: number; schema_version: number; schema_hash: string };
  payload: Record<string, unknown>;
  fields: ApiSubmissionField[];
}

type Db = SupabaseClient;

function notFound(what = "Not found."): never {
  throw new ApiError("NOT_FOUND", what, 404);
}

interface VersionRow {
  id: string;
  form_id: string;
  published_version_no: number;
  schema_version: number;
  schema_hash: string;
  renderer_version: string;
  published_at: string;
  schema_snapshot: unknown;
}

/** Latest published version per form (single batched query — never per row). */
async function latestVersions(
  db: Db,
  workspaceId: string,
  formIds: string[],
  opts?: { includeSnapshot?: boolean },
): Promise<Map<string, VersionRow>> {
  const out = new Map<string, VersionRow>();
  if (formIds.length === 0) return out;
  const columns = opts?.includeSnapshot === true
    ? "id, form_id, published_version_no, schema_version, schema_hash, renderer_version, published_at, schema_snapshot"
    : "id, form_id, published_version_no, schema_version, schema_hash, renderer_version, published_at";
  const { data, error } = await db
    .from("form_versions")
    .select(columns)
    .eq("workspace_id", workspaceId)
    .in("form_id", [...new Set(formIds)]);
  if (error) throw new ApiError("INTERNAL", "Could not load published versions.", 500);
  for (const row of ((data ?? []) as unknown as Array<VersionRow & { schema_snapshot: unknown } & { form_id: string }>)) {
    const cur = out.get(row.form_id);
    if (!cur || row.published_version_no > cur.published_version_no) out.set(row.form_id, row);
  }
  return out;
}

export async function apiListForms(
  db: Db,
  workspaceId: string,
  input: { limit?: number; cursor?: string },
): Promise<{ rows: ApiForm[]; nextCursor: string | null }> {
  const limit = clampLimit(input.limit);
  let query = db
    .from("forms")
    .select("id, key, title, description, status, schema_version, updated_at")
    .eq("workspace_id", workspaceId);
  if (input.cursor !== undefined) {
    const { t, id } = decodeCursor(input.cursor);
    query = query.or(`updated_at.lt.${t},and(updated_at.eq.${t},id.lt.${id})`);
  }
  const { data, error } = await query.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (error) throw new ApiError("INTERNAL", "Could not list forms.", 500);
  const rawRows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const latest = await latestVersions(db, workspaceId, pageRows.map((r) => r["id"] as string));
  const rows: ApiForm[] = pageRows.map((raw) => {
    const info = latest.get(raw["id"] as string);
    return {
      id: raw["id"] as string,
      key: raw["key"] as string,
      title: raw["title"] as string,
      description: (raw["description"] as string | null) ?? null,
      status: raw["status"] as string,
      updated_at: raw["updated_at"] as string,
      published_version: info
        ? {
            version_no: info.published_version_no,
            schema_version: info.schema_version,
            schema_hash: info.schema_hash,
            renderer_version: info.renderer_version,
            published_at: info.published_at,
          }
        : null,
    };
  });
  const last = pageRows[pageRows.length - 1];
  return { rows, nextCursor: hasMore && last ? encodeCursor(last["updated_at"] as string, last["id"] as string) : null };
}

export async function apiGetForm(db: Db, workspaceId: string, formId: string): Promise<ApiForm & { snapshot_included: false }> {
  if (!UUID_RE.test(formId)) notFound();
  const { data, error } = await db
    .from("forms")
    .select("id, key, title, description, status, schema_version, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("id", formId)
    .maybeSingle();
  if (error || !data) notFound();
  const row = data as Record<string, unknown>;
  const latest = await latestVersions(db, workspaceId, [formId]);
  const info = latest.get(formId);
  return {
    id: row["id"] as string,
    key: row["key"] as string,
    title: row["title"] as string,
    description: (row["description"] as string | null) ?? null,
    status: row["status"] as string,
    updated_at: row["updated_at"] as string,
    published_version: info
      ? {
          version_no: info.published_version_no,
          schema_version: info.schema_version,
          schema_hash: info.schema_hash,
          renderer_version: info.renderer_version,
          published_at: info.published_at,
        }
      : null,
    snapshot_included: false as const,
  };
}

/** Pinned snapshots + version metadata for a set of version ids (single query). */
async function pinnedSnapshots(
  db: Db,
  workspaceId: string,
  formId: string,
  versionIds: string[],
): Promise<
  Map<string, { snapshot: CanonicalForm; publishedVersionNo: number; schemaVersion: number; schemaHash: string }>
> {
  const map = new Map<string, { snapshot: CanonicalForm; publishedVersionNo: number; schemaVersion: number; schemaHash: string }>();
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return map;
  const { data, error } = await db
    .from("form_versions")
    .select("id, published_version_no, schema_version, schema_hash, schema_snapshot")
    .eq("workspace_id", workspaceId)
    .eq("form_id", formId)
    .in("id", ids);
  if (error) throw new ApiError("INTERNAL", "Could not load form versions.", 500);
  for (const row of (data ?? []) as Array<{ id: string; published_version_no: number; schema_version: number; schema_hash: string; schema_snapshot: unknown }>) {
    try {
      map.set(row.id, {
        snapshot: parseCanonicalForm(row.schema_snapshot),
        publishedVersionNo: row.published_version_no,
        schemaVersion: row.schema_version,
        schemaHash: row.schema_hash,
      });
    } catch {
      // Corrupt snapshot: fail closed on detail paths; list paths fall back below.
    }
  }
  return map;
}

/** Search keys unioned across recent versions (same semantics as inbox). */
async function searchKeysForApi(db: Db, workspaceId: string, formId: string): Promise<string[]> {
  const { data: versions } = await db
    .from("form_versions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("form_id", formId)
    .order("published_version_no", { ascending: false })
    .limit(20);
  const snaps = await pinnedSnapshots(
    db,
    workspaceId,
    formId,
    ((versions ?? []) as Array<{ id: string }>).map((v) => v.id),
  );
  const keys = new Set<string>();
  for (const info of snaps.values()) {
    for (const k of textSearchKeys(info.snapshot)) keys.add(k);
  }
  return [...keys];
}

export interface ApiSubmissionPage {
  rows: ApiSubmission[];
  total: number;
  nextCursor: string | null;
}

function toApiSubmission(
  raw: Record<string, unknown>,
  snapshot: CanonicalForm,
  publishedVersionNo: number,
  schemaVersion: number,
  schemaHash: string,
): ApiSubmission {
  const payload = (raw["payload"] as Record<string, unknown>) ?? {};
  const fields: ApiSubmissionField[] = [];
  const byKey = new Map<string, (typeof snapshot.pages)[number]["sections"][number]["fields"][number]>();
  for (const page of snapshot.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) byKey.set(field.key, field);
    }
  }
  for (const [key, field] of byKey) {
    const rendered = renderValue(field, payload[key]);
    const cell: ApiSubmissionField = {
      key,
      label: field.label,
      type: field.type,
      value: payload[key] ?? null,
      display: rendered.text,
    };
    if (rendered.href) cell.href = rendered.href;
    fields.push(cell);
  }
  return {
    id: raw["id"] as string,
    form_id: raw["form_id"] as string,
    status: raw["status"] as SubmissionStatus,
    submitted_at: raw["submitted_at"] as string,
    published_version: { version_no: publishedVersionNo, schema_version: schemaVersion, schema_hash: schemaHash },
    payload,
    fields,
  };
}

export async function apiListSubmissions(
  db: Db,
  workspaceId: string,
  formId: string,
  filters: SubmissionFilters,
  input: { limit?: number; cursor?: string },
): Promise<ApiSubmissionPage> {
  if (!UUID_RE.test(formId)) notFound();
  // Confirm form ownership first (uniform 404 on mismatch).
  const { data: formRow, error: formErr } = await db
    .from("forms")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", formId)
    .maybeSingle();
  if (formErr || !formRow) notFound();
  if (filters.status !== undefined && !isSubmissionStatus(filters.status)) {
    throw new ApiError("VALIDATION_FAILED", "Invalid status filter.", 400);
  }
  const limit = clampLimit(input.limit);
  let searchKeys: string[] = [];
  if (filters.q !== undefined && filters.q.trim() !== "") {
    searchKeys = await searchKeysForApi(db, workspaceId, formId);
  }
  let query = db
    .from("submissions")
    .select("id, form_id, publication_id, form_version_id, status, submitted_at, status_changed_at, payload", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .eq("form_id", formId);
  if (filters.status !== undefined) query = query.eq("status", filters.status);
  if (filters.from !== undefined && filters.from !== "") query = query.gte("submitted_at", filters.from);
  if (filters.to !== undefined && filters.to !== "") query = query.lt("submitted_at", filters.to);
  const q = filters.q?.trim() ?? "";
  if (q !== "") {
    const orExpr = buildSearchOr(q, searchKeys);
    query = orExpr !== null ? query.or(orExpr) : query.eq("id", "00000000-0000-0000-0000-000000000000");
  }
  if (input.cursor !== undefined) {
    const { t, id } = decodeCursor(input.cursor);
    query = query.or(keysetOr(t, id));
  }
  const { data, error, count } = await query
    .order("submitted_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new ApiError("INTERNAL", "Could not list submissions.", 500);
  const rawRows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const snaps = await pinnedSnapshots(
    db,
    workspaceId,
    formId,
    pageRows.map((r) => r["form_version_id"] as string),
  );
  const rows: ApiSubmission[] = [];
  for (const raw of pageRows) {
    const info = snaps.get(raw["form_version_id"] as string);
    if (!info) notFound();
    rows.push(toApiSubmission(raw, info.snapshot, info.publishedVersionNo, info.schemaVersion, info.schemaHash));
  }
  const last = pageRows[pageRows.length - 1];
  return {
    rows,
    total: count ?? rows.length,
    nextCursor: hasMore && last ? encodeCursor(last["submitted_at"] as string, last["id"] as string) : null,
  };
}

export async function apiGetSubmission(
  db: Db,
  workspaceId: string,
  submissionId: string,
): Promise<ApiSubmission> {
  if (!UUID_RE.test(submissionId)) notFound();
  const { data, error } = await db
    .from("submissions")
    .select("id, form_id, publication_id, form_version_id, status, submitted_at, status_changed_at, payload")
    .eq("workspace_id", workspaceId)
    .eq("id", submissionId)
    .maybeSingle();
  if (error || !data) notFound();
  const row = data as Record<string, unknown>;
  const snaps = await pinnedSnapshots(db, workspaceId, row["form_id"] as string, [row["form_version_id"] as string]);
  const info = snaps.get(row["form_version_id"] as string);
  if (!info) notFound();
  return toApiSubmission(row, info.snapshot, info.publishedVersionNo, info.schemaVersion, info.schemaHash);
}

export interface ApiDelivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  response_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export async function apiListDeliveries(
  db: Db,
  workspaceId: string,
  endpointId: string,
  input: { limit?: number; cursor?: string },
): Promise<{ rows: ApiDelivery[]; nextCursor: string | null }> {
  if (!UUID_RE.test(endpointId)) notFound();
  const { data: ep, error: epErr } = await db
    .from("webhook_endpoints")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", endpointId)
    .maybeSingle();
  if (epErr || !ep) notFound();
  const limit = clampLimit(input.limit);
  let query = db
    .from("webhook_deliveries")
    .select("id, event_type, status, attempts, next_attempt_at, response_code, last_error, delivered_at, created_at")
    .eq("workspace_id", workspaceId)
    .eq("endpoint_id", endpointId);
  if (input.cursor !== undefined) {
    const { t, id } = decodeCursor(input.cursor);
    query = query.or(`created_at.lt.${t},and(created_at.eq.${t},id.lt.${id})`);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new ApiError("INTERNAL", "Could not list deliveries.", 500);
  const rawRows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const rows: ApiDelivery[] = pageRows.map((r) => ({
    id: r["id"] as string,
    event_type: r["event_type"] as string,
    status: r["status"] as string,
    attempts: r["attempts"] as number,
    next_attempt_at: (r["next_attempt_at"] as string | null) ?? null,
    response_code: (r["response_code"] as number | null) ?? null,
    last_error: (r["last_error"] as string | null) ?? null,
    delivered_at: (r["delivered_at"] as string | null) ?? null,
    created_at: r["created_at"] as string,
  }));
  const last = pageRows[pageRows.length - 1];
  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor(last["created_at"] as string, last["id"] as string) : null,
  };
}
