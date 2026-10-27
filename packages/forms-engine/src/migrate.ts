/**
 * Schema versioning: parse → detect schemaVersion → migrate → validate.
 *
 * Rules (VERSIONING.md, FORM-SCHEMA.md):
 * - `schemaVersion` is the canonical shape contract; bump ONLY on breaking change.
 * - Migrations are forward-only codemods. Published snapshots are NEVER
 *   migrated in place; drafts auto-migrate on open (bumping the draft only).
 * - Unknown future versions are rejected safely — never guessed.
 */
import { createHash } from "node:crypto";
import { SCHEMA_VERSION, type CanonicalForm, type PublishedSnapshot } from "./schema.js";

export class CanonicalError extends Error {
  readonly code: "invalid_shape" | "unsupported_version" | "semantic";
  constructor(code: CanonicalError["code"], message: string) {
    super(message);
    this.name = "CanonicalError";
    this.code = code;
  }
}

/**
 * Forward-only codemods keyed by the version they migrate FROM.
 * v1 is the genesis contract, so the registry starts empty by design:
 * adding a v2 contract means adding `1: (doc) => docV2` here.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrateToCurrent(input: unknown): { version: number; doc: Record<string, unknown> } {
  if (typeof input !== "object" || input === null) {
    throw new CanonicalError("invalid_shape", "canonical form must be an object");
  }
  const doc = input as Record<string, unknown>;
  const version = doc["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new CanonicalError("invalid_shape", "schemaVersion must be a positive integer");
  }
  if (version > SCHEMA_VERSION) {
    throw new CanonicalError(
      "unsupported_version",
      `schemaVersion ${version} is newer than supported ${SCHEMA_VERSION}; refusing to guess`,
    );
  }
  let current = version;
  let migrated: Record<string, unknown> = { ...doc };
  while (current < SCHEMA_VERSION) {
    const step = MIGRATIONS[current];
    if (!step) {
      throw new CanonicalError("invalid_shape", `no forward migration registered from schemaVersion ${current}`);
    }
    migrated = step(migrated);
    current += 1;
  }
  return { version: SCHEMA_VERSION, doc: migrated };
}

/** Deterministic canonical JSON: recursively sorted keys, stable across runs. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Content hash pinning a snapshot (submissions pin form+version+hash). */
export function hashCanonical(form: CanonicalForm): string {
  return createHash("sha256").update(stableStringify(form), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    for (const key of Object.getOwnPropertyNames(value)) {
      const prop = (value as Record<string, unknown>)[key];
      deepFreeze(prop);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Mint an immutable published snapshot. The snapshot is deep-frozen: any later
 * mutation attempt throws, so a "published" version can never change underneath
 * respondents, exports, or analytics. Rollback = republish (new version), never edit.
 */
export function createPublishedSnapshot(form: CanonicalForm, publishedVersion: number): PublishedSnapshot {
  if (!Number.isInteger(publishedVersion) || publishedVersion < 1) {
    throw new CanonicalError("invalid_shape", "publishedVersion must be a positive integer");
  }
  const clone: CanonicalForm = JSON.parse(stableStringify(form)) as CanonicalForm;
  const snapshot: PublishedSnapshot = {
    publishedVersion,
    schemaHash: hashCanonical(clone),
    schema: clone,
  };
  return deepFreeze(snapshot);
}
