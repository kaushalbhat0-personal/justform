/**
 * FORMOS → JSON Schema (draft-07, renderer-facing derivation).
 *
 * Constraints (ADR-003): simple constructs ONLY — no `anyOf`/`oneOf`/`$ref`/
 * schema-`if-then-else`. Conditional behavior lives in the FORMOS rules
 * interpreter, never in schema conditionals, keeping the renderer
 * validator-independent. Deterministic: fixed key order, document field order.
 */
import type { CanonicalForm, FormField } from "./schema.js";

export interface JsonSchemaNode {
  type: string;
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Numeric bounds for number/integer; lexicographic bounds for date/time strings. */
  minimum?: number | string;
  maximum?: number | string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: string[];
  items?: JsonSchemaNode;
}

export interface JsonSchemaDocument {
  $schema: "http://json-schema.org/draft-07/schema#";
  type: "object";
  title: string;
  description?: string;
  properties: Record<string, JsonSchemaNode>;
  required: string[];
  additionalProperties: false;
}

const E164 = "^\\+[1-9]\\d{7,14}$";
const TIME_RE = "^([01]\\d|2[0-3]):[0-5]\\d$";

function nodeFor(field: FormField): JsonSchemaNode {
  const title = field.label;
  const description = field.description;
  const defaultValue = field.default;
  // Strip undefined so output keys are deterministic under exactOptionalPropertyTypes.
  const withCommon = (node: Record<string, unknown>): JsonSchemaNode => {
    const out: Record<string, unknown> = { title };
    if (description !== undefined) out["description"] = description;
    if (defaultValue !== undefined) out["default"] = defaultValue;
    for (const [k, v] of Object.entries(node)) {
      if (v !== undefined) out[k] = v;
    }
    return out as unknown as JsonSchemaNode;
  };
  switch (field.type) {
    case "short_text": {
      const v = field.validation ?? {};
      return withCommon({
        type: "string",
        minLength: v.minLength,
        maxLength: v.maxLength,
        pattern: v.pattern,
      });
    }
    case "long_text": {
      const v = field.validation ?? {};
      return withCommon({ type: "string", minLength: v.minLength, maxLength: v.maxLength });
    }
    case "email":
      return withCommon({ type: "string", format: "email" });
    case "number": {
      const v = field.validation ?? {};
      return withCommon({
        type: v.integer === true ? "integer" : "number",
        minimum: v.min,
        maximum: v.max,
      });
    }
    case "phone":
      return withCommon({ type: "string", pattern: E164 });
    case "dropdown":
    case "radio":
      return withCommon({ type: "string", enum: field.config.options.map((o) => o.value) });
    case "checkbox": {
      const v = field.validation ?? {};
      return withCommon({
        type: "array",
        // uniqueItems is required for RJSF to route multi-enum arrays to its
        // checkboxes path (still a simple draft-07 construct; unenforced —
        // Zod is the authority and the UI cannot produce duplicates).
        uniqueItems: true,
        items: { type: "string", enum: field.config.options.map((o) => o.value) },
        minItems: v.minItems ?? (field.required ? 1 : undefined),
        maxItems: v.maxItems,
      });
    }
    case "date": {
      const v = field.validation ?? {};
      return withCommon({ type: "string", format: "date", minimum: v.min, maximum: v.max });
    }
    case "time": {
      const v = field.validation ?? {};
      return withCommon({ type: "string", pattern: TIME_RE, minimum: v.min, maximum: v.max });
    }
    case "file": {
      const v = field.validation;
      return withCommon({
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: field.required ? 1 : undefined,
        maxItems: v.maxCount,
      });
    }
    case "hidden":
      return withCommon({ type: "string" });
    default:
      // `x-` extensions: carried as an unconstrained string so the renderer
      // can ignore + flag without blocking sibling fields.
      return withCommon({ type: "string" });
  }
}

/** Derive the renderer's JSON Schema from the canonical form. Pure + deterministic. */
export function generateJsonSchema(form: CanonicalForm): JsonSchemaDocument {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const page of form.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) {
        properties[field.key] = nodeFor(field);
        if (field.required) required.push(field.key);
      }
    }
  }
  const doc: JsonSchemaDocument = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    title: form.metadata.title,
    properties,
    required,
    additionalProperties: false,
  };
  if (form.metadata.description !== undefined) doc.description = form.metadata.description;
  return doc;
}
