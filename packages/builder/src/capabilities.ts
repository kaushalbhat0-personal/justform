/**
 * Field capability registry — the ONE source the palette and the property
 * editor both derive from. Types come from the canonical MVP-12 list
 * (`@formos/forms-engine`); nothing is recreated here.
 *
 * Adding a palette entry = adding a case below. Property editors must read
 * `editableConstraints` / `supports*` flags rather than switching on type
 * a second time.
 */
import { MVP_FIELD_TYPES, type FormField, type MvpFieldType } from "@formos/forms-engine";

export type { MvpFieldType };

export type ConstraintKind =
  | "minLength"
  | "maxLength"
  | "pattern"
  | "min"
  | "max"
  | "integer"
  | "minItems"
  | "maxItems"
  | "notPast"
  | "notFuture"
  | "maxMB"
  | "mime"
  | "maxCount";

export interface FieldCapability {
  type: MvpFieldType;
  /** Palette label. */
  label: string;
  description: string;
  defaultLabel: string;
  supportsOptions: boolean;
  supportsPlaceholder: boolean;
  supportsDefault: boolean;
  /** Constraint editors the property panel may render for this type. */
  editableConstraints: ConstraintKind[];
}

/** Minimal VALID canonical field per type (ids/keys/labels filled by the caller). */
function base(type: MvpFieldType, id: string, key: string, label: string): FormField {
  switch (type) {
    case "short_text":
      return { id, key, type, label, required: false };
    case "long_text":
      return { id, key, type, label, required: false };
    case "email":
      return { id, key, type, label, required: false };
    case "number":
      return { id, key, type, label, required: false };
    case "phone":
      return { id, key, type, label, required: false };
    case "dropdown":
      return {
        id,
        key,
        type,
        label,
        required: false,
        config: {
          options: [
            { value: "option_1", label: "Option 1" },
            { value: "option_2", label: "Option 2" },
          ],
        },
      };
    case "radio":
      return {
        id,
        key,
        type,
        label,
        required: false,
        config: {
          options: [
            { value: "option_1", label: "Option 1" },
            { value: "option_2", label: "Option 2" },
          ],
        },
      };
    case "checkbox":
      return {
        id,
        key,
        type,
        label,
        required: false,
        config: {
          options: [
            { value: "option_1", label: "Option 1" },
            { value: "option_2", label: "Option 2" },
          ],
        },
      };
    case "date":
      return { id, key, type, label, required: false };
    case "time":
      return { id, key, type, label, required: false };
    case "file":
      return {
        id,
        key,
        type,
        label,
        required: false,
        validation: { maxMB: 10, mime: ["application/pdf"], maxCount: 3 },
      };
    case "hidden":
      return { id, key, type, label, required: false };
  }
}

const TEXT_CONSTRAINTS: ConstraintKind[] = ["minLength", "maxLength", "pattern"];

export const FIELD_CAPABILITIES: Record<MvpFieldType, FieldCapability> = {
  short_text: {
    type: "short_text",
    label: "Short text",
    description: "Single-line text input",
    defaultLabel: "Untitled text",
    supportsOptions: false,
    supportsPlaceholder: true,
    supportsDefault: true,
    editableConstraints: TEXT_CONSTRAINTS,
  },
  long_text: {
    type: "long_text",
    label: "Long text",
    description: "Multi-line textarea",
    defaultLabel: "Untitled paragraph",
    supportsOptions: false,
    supportsPlaceholder: true,
    supportsDefault: true,
    editableConstraints: ["minLength", "maxLength"],
  },
  email: {
    type: "email",
    label: "Email",
    description: "Email address with format validation",
    defaultLabel: "Untitled email",
    supportsOptions: false,
    supportsPlaceholder: true,
    supportsDefault: true,
    editableConstraints: [],
  },
  number: {
    type: "number",
    label: "Number",
    description: "Numeric input with optional range",
    defaultLabel: "Untitled number",
    supportsOptions: false,
    supportsPlaceholder: true,
    supportsDefault: true,
    editableConstraints: ["min", "max", "integer"],
  },
  phone: {
    type: "phone",
    label: "Phone",
    description: "E.164 phone number",
    defaultLabel: "Untitled phone",
    supportsOptions: false,
    supportsPlaceholder: true,
    supportsDefault: true,
    editableConstraints: [],
  },
  dropdown: {
    type: "dropdown",
    label: "Dropdown",
    description: "Single choice from a list",
    defaultLabel: "Untitled dropdown",
    supportsOptions: true,
    supportsPlaceholder: false,
    supportsDefault: true,
    editableConstraints: [],
  },
  radio: {
    type: "radio",
    label: "Radio",
    description: "Single choice as radio buttons",
    defaultLabel: "Untitled choice",
    supportsOptions: true,
    supportsPlaceholder: false,
    supportsDefault: true,
    editableConstraints: [],
  },
  checkbox: {
    type: "checkbox",
    label: "Checkboxes",
    description: "Multiple choices with optional limits",
    defaultLabel: "Untitled checkboxes",
    supportsOptions: true,
    supportsPlaceholder: false,
    supportsDefault: false,
    editableConstraints: ["minItems", "maxItems"],
  },
  date: {
    type: "date",
    label: "Date",
    description: "Calendar date with optional range",
    defaultLabel: "Untitled date",
    supportsOptions: false,
    supportsPlaceholder: false,
    supportsDefault: true,
    editableConstraints: ["min", "max", "notPast", "notFuture"],
  },
  time: {
    type: "time",
    label: "Time",
    description: "Time of day with optional range",
    defaultLabel: "Untitled time",
    supportsOptions: false,
    supportsPlaceholder: false,
    supportsDefault: true,
    editableConstraints: ["min", "max"],
  },
  file: {
    type: "file",
    label: "File",
    description: "Attachment references (grant flow)",
    defaultLabel: "Untitled attachments",
    supportsOptions: false,
    supportsPlaceholder: false,
    supportsDefault: false,
    editableConstraints: ["maxMB", "mime", "maxCount"],
  },
  hidden: {
    type: "hidden",
    label: "Hidden",
    description: "Prefilled value, never rendered",
    defaultLabel: "Untitled hidden",
    supportsOptions: false,
    supportsPlaceholder: false,
    supportsDefault: true,
    editableConstraints: [],
  },
};

/** Palette order (fixed, deterministic). */
export const PALETTE_ORDER: MvpFieldType[] = [...MVP_FIELD_TYPES];

/** Minimal valid canonical field; caller supplies stable id + unique key. */
export function createDefaultField(type: MvpFieldType, id: string, key: string, label?: string): FormField {
  const capability = FIELD_CAPABILITIES[type];
  return base(type, id, key, label ?? capability.defaultLabel);
}
