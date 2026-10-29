import { DomainError } from "@formos/domain";
import { INBOX_PAGE_SIZE_DEFAULT, INBOX_PAGE_SIZE_MAX } from "./types";

/**
 * Pure server-side query primitives shared by inbox list and Tables v1.
 * No server-only imports: unit-testable in isolation, no I/O, no secrets.
 * PostgREST `or()` syntax constraints are centralized here (single owner).
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;
export { UUID_RE };
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function failNotFound(): never {
  throw new DomainError({ code: "not_found", message: "Submission not found." });
}

export function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? INBOX_PAGE_SIZE_DEFAULT, 1), INBOX_PAGE_SIZE_MAX);
}

export function encodeCursor(t: string, id: string): string {
  return Buffer.from(JSON.stringify({ t, id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const json = Buffer.from(cursor.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed = JSON.parse(json) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new Error("bad cursor");
    if (Number.isNaN(Date.parse(parsed.t)) || !UUID_RE.test(parsed.id)) throw new Error("bad cursor");
    return { t: parsed.t, id: parsed.id };
  } catch {
    failNotFound();
  }
}

/** Escape PostgREST LIKE into a safe *…* pattern (`,`/`(`/`)` are stripped: or() syntax). */
export function likePattern(q: string): string {
  const sanitized = q.replace(/[,()]/g, "");
  return `*${sanitized.replace(/[\\%_]/g, (c) => `\\${c}`)}*`;
}

/**
 * Build the PostgREST `or()` text-search expression over payload keys.
 * Returns null when there is no searchable surface (caller forces empty page).
 * UUID-shaped queries also match the row id exactly.
 */
export function buildSearchOr(q: string, searchKeys: string[]): string | null {
  const clauses: string[] = [];
  if (UUID_RE.test(q)) clauses.push(`id.eq.${q}`);
  if (searchKeys.length > 0) {
    const pattern = likePattern(q);
    for (const key of searchKeys) clauses.push(`payload->>${key}.ilike.${pattern}`);
  }
  return clauses.length > 0 ? clauses.join(",") : null;
}

/** Keyset predicate for (submitted_at DESC, id DESC) pagination. */
export function keysetOr(t: string, id: string): string {
  return `submitted_at.lt.${t},and(submitted_at.eq.${t},id.lt.${id})`;
}

/** Mirror predicate for the chronological-neighbor queries (detail prev/next). */
export function neighborOr(direction: "older" | "newer", t: string, id: string): string {
  return direction === "older"
    ? `submitted_at.lt.${t},and(submitted_at.eq.${t},id.lt.${id})`
    : `submitted_at.gt.${t},and(submitted_at.eq.${t},id.gt.${id})`;
}
