import "server-only";
import { createClient } from "@supabase/supabase-js";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";
import { serverEnv } from "../env";

/**
 * Server-side public-form resolution (Phase 6).
 * Anonymous lookup through the redacted DEFINER resolver — the server decides
 * which published snapshot is authoritative; the browser never fetches the
 * draft and never supplies a schema.
 */

const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ResolvedPublicFormOk {
  ok: true;
  available: true;
  publicId: string;
  title: string;
  description: string | null;
  publishedVersionNo: number;
  schemaVersion: number;
  schemaHash: string;
  rendererVersion: string;
  snapshot: CanonicalForm;
}

export interface ResolvedPublicFormClosed {
  ok: true;
  available: false;
  reason: "not_open" | "closed" | "capped";
  publicId: string;
}

export interface ResolvedPublicFormMissing {
  ok: false;
  code: "FORM_NOT_AVAILABLE";
}

export type ResolvedPublicForm = ResolvedPublicFormOk | ResolvedPublicFormClosed | ResolvedPublicFormMissing;

interface ResolverRow {
  available: boolean;
  reason?: string;
  public_id?: string;
  title?: string;
  description?: string | null;
  published_version_no?: number;
  schema_snapshot?: unknown;
  schema_version?: number;
  schema_hash?: string;
  renderer_version?: string;
}

/** Anonymous Supabase client (no session): RLS sees the anon role. */
function anonClient(): ReturnType<typeof createClient> {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}

export async function resolvePublicForm(publicId: string): Promise<ResolvedPublicForm> {
  if (!PUBLIC_ID_RE.test(publicId)) return { ok: false, code: "FORM_NOT_AVAILABLE" };
  const supabase = anonClient();
  // Untyped RPC surface (no generated Database types): the resolver returns
  // a JSONB row or a PostgREST error — both handled without trusting detail.
  // NOTE: keep the method on the client object — detaching `supabase.rpc`
  // loses its `this` binding and throws inside postgrest-js.
  const client = supabase as unknown as {
    rpc(fn: string, args: { p_public_id: string }): Promise<{ data: unknown; error: { message: string } | null }>;
  };
  const { data, error } = await client.rpc("resolve_public_form", { p_public_id: publicId });
  if (error) {
    // Uniform miss/inactive: no enumeration oracle (message never forwarded).
    return { ok: false, code: "FORM_NOT_AVAILABLE" };
  }
  const row = data as ResolverRow;
  if (!row || row.available !== true) {
    const reason = row?.reason === "not_open" || row?.reason === "capped" ? row.reason : "closed";
    return { ok: true, available: false, reason, publicId };
  }
  let snapshot: CanonicalForm;
  try {
    snapshot = parseCanonicalForm(row.schema_snapshot);
  } catch (err) {
    // Corrupt snapshot is an integrity failure: log server-side, stay safe.
    console.error(`[public-form] snapshot failed canonical parse for publicId (hash=${row.schema_hash ?? "?"}):`, err instanceof Error ? err.message : err);
    return { ok: false, code: "FORM_NOT_AVAILABLE" };
  }
  return {
    ok: true,
    available: true,
    publicId,
    title: row.title ?? "Form",
    description: row.description ?? null,
    publishedVersionNo: row.published_version_no ?? 0,
    schemaVersion: row.schema_version ?? snapshot.schemaVersion,
    schemaHash: row.schema_hash ?? "",
    rendererVersion: row.renderer_version ?? "",
    snapshot,
  };
}
