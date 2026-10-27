/**
 * Normalized error contract: Zod issues → stable FORMOS errors + RJSF ErrorSchema.
 *
 * RJSF/JSON Schema paths (e.g. `["topics", 1]`) are resolved back to canonical
 * field identities. Library error objects are never copied into the domain —
 * they are translated into `FormValidationError` and, separately, into the
 * minimal `ErrorSchema` shape RJSF needs for display (`extraErrors`).
 */
import type { ZodIssue } from "zod";
import type { FormField } from "./schema.js";

/** Stable, renderer-independent validation error. */
export interface FormValidationError {
  /** Canonical stable field `id` ("" when the path resolves to no field). */
  fieldId: string;
  /** Canonical stable field `key` (first path segment, or ""). */
  key: string;
  /** Full normalized path, e.g. ["topics", 1]. */
  path: Array<string | number>;
  /** Stable machine code: required | invalid_type | min_length | max_length | pattern | email | ... */
  code: string;
  message: string;
  /** Which authority produced this error. Always "zod" in Phase 2. */
  source: "zod";
}

/** Minimal RJSF ErrorSchema shape (owned — no RJSF import in forms-engine). */
export interface RjsfErrorSchema {
  __errors?: string[];
  [child: string]: RjsfErrorSchema | string[] | undefined;
}

function codeFor(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" || issue.received === "null" ? "required" : "invalid_type";
    case "too_small":
      if (issue.type === "string") return issue.minimum === 1 && issue.inclusive ? "required" : "min_length";
      if (issue.type === "array") return "min_items";
      if (issue.type === "number") return "min_value";
      return "too_small";
    case "too_big":
      if (issue.type === "string") return "max_length";
      if (issue.type === "array") return "max_items";
      if (issue.type === "number") return "max_value";
      return "too_big";
    case "invalid_string":
      if (issue.validation === "email") return "email";
      if (issue.validation === "uuid") return "uuid";
      if (issue.validation === "date") return "date";
      if (issue.validation === "regex") return "pattern";
      return "invalid_string";
    case "invalid_enum_value":
      return "not_in_enum";
    case "unrecognized_keys":
      return "unknown_key";
    case "custom":
      return "custom";
    default:
      return "invalid";
  }
}

/** Translate Zod issues to stable FORMOS errors, resolved to canonical field ids. */
export function toFormValidationErrors(
  issues: readonly ZodIssue[],
  byKey: ReadonlyMap<string, FormField>,
): FormValidationError[] {
  return issues.map((issue) => {
    const path = issue.path.map((seg) => (typeof seg === "number" ? seg : String(seg)));
    const key = typeof path[0] === "string" ? path[0] : "";
    const field = key !== "" ? byKey.get(key) : undefined;
    return {
      fieldId: field?.id ?? "",
      key,
      path,
      code: codeFor(issue),
      message: issue.message,
      source: "zod" as const,
    };
  });
}

/** Fold translated errors into the nested ErrorSchema RJSF `extraErrors` expects. */
export function toRjsfErrorSchema(errors: readonly FormValidationError[]): RjsfErrorSchema {
  const root: RjsfErrorSchema = {};
  for (const error of errors) {
    let node = root;
    for (const segment of error.path) {
      const name = String(segment);
      const next = node[name];
      if (typeof next !== "object" || next === null || Array.isArray(next)) {
        node[name] = {};
      }
      node = node[name] as RjsfErrorSchema;
    }
    node.__errors = [...(node.__errors ?? []), error.message];
  }
  return root;
}

/** One-step adapter used by the submit gate: issues → both representations. */
export function zodIssuesToErrorSchema(
  issues: readonly ZodIssue[],
  byKey: ReadonlyMap<string, FormField>,
): { errors: FormValidationError[]; errorSchema: RjsfErrorSchema } {
  const errors = toFormValidationErrors(issues, byKey);
  return { errors, errorSchema: toRjsfErrorSchema(errors) };
}
