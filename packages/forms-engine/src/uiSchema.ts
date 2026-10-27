/**
 * FORMOS → uiSchema (renderer-facing derivation).
 *
 * Maps canonical presentation hints to RJSF widget selections. Deterministic:
 * `ui:order` follows document order; per-field entries use fixed key order.
 * The `formosFileRef` widget is a renderer-registered extension (never bytes).
 */
import type { CanonicalForm, FormField } from "./schema.js";

export interface UiFieldSchema {
  "ui:widget"?: string;
  "ui:placeholder"?: string;
  "ui:options"?: Record<string, unknown>;
}

export interface UiSchema {
  "ui:order": string[];
  [key: string]: UiFieldSchema | string[];
}

function uiFor(field: FormField): UiFieldSchema {
  const ui: UiFieldSchema = {};
  const placeholder = field.presentation?.placeholder;
  if (placeholder !== undefined) ui["ui:placeholder"] = placeholder;
  const options: Record<string, unknown> = {};
  switch (field.type) {
    case "long_text":
      ui["ui:widget"] = "textarea";
      break;
    case "email":
      options["autocomplete"] = "email";
      break;
    case "number":
      options["inputmode"] = "decimal";
      break;
    case "phone":
      options["autocomplete"] = "tel";
      options["inputmode"] = "tel";
      break;
    case "radio":
      ui["ui:widget"] = "radio";
      break;
    case "checkbox":
      ui["ui:widget"] = "checkboxes";
      break;
    case "date":
      ui["ui:widget"] = "date";
      break;
    case "time":
      ui["ui:widget"] = "time";
      break;
    case "file":
      // Grant-flow reference widget (Phase 6 pipeline); the derivation only names it.
      ui["ui:widget"] = "formosFileRef";
      break;
    case "hidden":
      ui["ui:widget"] = "hidden";
      break;
    default:
      break;
  }
  if (Object.keys(options).length > 0) ui["ui:options"] = options;
  return ui;
}

/** Derive the renderer's uiSchema from the canonical form. Pure + deterministic. */
export function generateUiSchema(form: CanonicalForm): UiSchema {
  const order: string[] = [];
  const entries: Record<string, UiFieldSchema> = {};
  for (const page of form.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) {
        order.push(field.key);
        entries[field.key] = uiFor(field);
      }
    }
  }
  return { "ui:order": order, ...entries };
}
