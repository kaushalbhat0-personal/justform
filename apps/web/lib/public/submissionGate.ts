/**
 * Client-safe submission gate builder (Phase 6 public path).
 *
 * Derives the RJSF artifacts (JSON Schema + uiSchema) and the Zod submit
 * gate from an immutable published canonical snapshot. The SAME generator
 * runs here (respondent browser, pre-submit) and in the API route
 * (pre-RPC) — agreement is structural (single generator), never a
 * browser-supplied schema. No server-only imports: safe for client bundles.
 */
import {
  generateJsonSchema,
  generateUiSchema,
  toRjsfErrorSchema,
  validateSubmission,
  type CanonicalForm,
} from "@formos/forms-engine";
import type { SubmissionGate } from "@formos/renderer";

/** Zod-authority gate over a pinned published snapshot. */
export function makeSubmissionGate(form: CanonicalForm): SubmissionGate {
  return (data: unknown) => {
    const result = validateSubmission(form, data);
    if (result.ok) return { ok: true, values: result.values };
    // validateSubmission already returns translated FormValidationErrors;
    // fold them into the RJSF error schema the renderer displays.
    return { ok: false, errors: result.errors, errorSchema: toRjsfErrorSchema(result.errors) };
  };
}

/** Canonical keys of file-type fields (gated: pipeline deferred). */
export function fileFieldKeys(form: CanonicalForm): string[] {
  const keys: string[] = [];
  for (const page of form.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) {
        if (field.type === "file") keys.push(field.key);
      }
    }
  }
  return keys;
}

/** Renderer artifacts derived from the pinned snapshot (server or client). */
export function buildRendererArtifacts(form: CanonicalForm): {
  jsonSchema: ReturnType<typeof generateJsonSchema>;
  uiSchema: ReturnType<typeof generateUiSchema>;
} {
  return { jsonSchema: generateJsonSchema(form), uiSchema: generateUiSchema(form) };
}
