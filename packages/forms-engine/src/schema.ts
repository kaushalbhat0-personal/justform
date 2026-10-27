/**
 * Canonical FORMOS form schema — the SOLE source of truth (FORM-SCHEMA.md, FIELDS.md).
 *
 * PURITY CONTRACT: this module has ZERO imports. It must never import React,
 * RJSF, React Hook Form, Zod, Next.js, Supabase, or database models. All
 * derivations (JSON Schema / uiSchema / Zod) and interpreters (rules,
 * calculations) consume these types but live in their own modules.
 *
 * A form is a document: stable field identities (`id`), stable API/slug keys
 * (`key`), renderer-independent validation vocabulary, declarative rules and
 * calculations (AST only — never executable code).
 */

/** Current canonical contract version. Bump ONLY on breaking shape change. */
export const SCHEMA_VERSION = 1;

/** MVP-12 closed registry (FIELDS.md). Anything else must use the `x-` namespace. */
export const MVP_FIELD_TYPES = [
  "short_text",
  "long_text",
  "email",
  "number",
  "phone",
  "dropdown",
  "radio",
  "checkbox",
  "date",
  "time",
  "file",
  "hidden",
] as const;
export type MvpFieldType = (typeof MVP_FIELD_TYPES)[number];

/** Canonical option: the `value` is persisted; `label` is display-only. */
export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

/* ------------------------------------------------------------------ */
/* Validation vocabulary (renderer-independent; Zod generator maps it) */
/* ------------------------------------------------------------------ */

export interface TextValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}
export interface NumberValidation {
  min?: number;
  max?: number;
  integer?: boolean;
}
/** Email semantics are fixed (RFC + Zod email); no parameters. */
export interface EmailValidation {
  kind?: "email";
}
export interface PhoneValidation {
  /** Region code for the formats registry (e.g. "AU"); generator default is E.164. */
  region?: string;
}
/** Choice fields are inherently a closed set over `config.options`. */
export interface ChoiceValidation {
  kind?: "choice";
}
export interface MultiValidation {
  minItems?: number;
  maxItems?: number;
}
export interface DateValidation {
  /** Inclusive bounds, `YYYY-MM-DD`. */
  min?: string;
  max?: string;
  notPast?: boolean;
  notFuture?: boolean;
}
export interface TimeValidation {
  /** Inclusive bounds, `HH:MM` (24h). Lexicographic comparison is chronological. */
  min?: string;
  max?: string;
}
export interface FileValidation {
  maxMB: number;
  /** Allowlist of MIME types, e.g. ["application/pdf"]. */
  mime: string[];
  maxCount: number;
}

/* ------------------------------------------------------------------ */
/* Fields: stable identity + discriminated union per type               */
/* ------------------------------------------------------------------ */

interface FieldBase {
  /** Stable UUID, immutable across versions, never reused. Joins renderer/submissions/analytics. */
  id: string;
  /** Stable slug `[a-z0-9_]{1,64}`, unique per form. Stable for API/analytics. */
  key: string;
  label: string;
  description?: string;
  /** Static requiredness. Conditional requiredness lives in `rules`. */
  required: boolean;
  /** Static respondent invisibility (e.g. `hidden` type). Conditional visibility lives in `rules`. */
  hidden?: boolean;
  /** Canonical default applied during submission normalization. Never executable. */
  default?: unknown;
  /** Display hints only — never validation, never authority. */
  presentation?: {
    placeholder?: string;
    width?: "full" | "half" | "third";
  };
}

export interface ShortTextField extends FieldBase {
  type: "short_text";
  config?: Record<string, never>;
  validation?: TextValidation;
}
export interface LongTextField extends FieldBase {
  type: "long_text";
  config?: Record<string, never>;
  validation?: TextValidation;
}
export interface EmailField extends FieldBase {
  type: "email";
  config?: Record<string, never>;
  validation?: EmailValidation;
}
export interface NumberField extends FieldBase {
  type: "number";
  config?: Record<string, never>;
  validation?: NumberValidation;
}
export interface PhoneField extends FieldBase {
  type: "phone";
  config?: Record<string, never>;
  validation?: PhoneValidation;
}
export interface DropdownField extends FieldBase {
  type: "dropdown";
  config: { options: FieldOption[] };
  validation?: ChoiceValidation;
}
export interface RadioField extends FieldBase {
  type: "radio";
  config: { options: FieldOption[] };
  validation?: ChoiceValidation;
}
export interface CheckboxField extends FieldBase {
  type: "checkbox";
  config: { options: FieldOption[] };
  validation?: MultiValidation;
}
export interface DateField extends FieldBase {
  type: "date";
  config?: Record<string, never>;
  validation?: DateValidation;
}
export interface TimeField extends FieldBase {
  type: "time";
  config?: Record<string, never>;
  validation?: TimeValidation;
}
/**
 * Canonical file value is `string[]` (attachment IDs — refs, never bytes).
 * Relational `attachments` rows + the `{attachment_ids}` storage envelope are
 * a Phase 6 persistence concern, not part of the S1/S2 runtime value.
 */
export interface FileField extends FieldBase {
  type: "file";
  config?: Record<string, never>;
  validation: FileValidation;
}
export interface HiddenField extends FieldBase {
  type: "hidden";
  config?: Record<string, never>;
  validation?: Record<string, never>;
  /** Declarative prefill source. Resolution is a later-phase engine concern. */
  prefill?: { source: "query" | "auth"; path: string };
}

/**
 * Extension point: custom types MUST use the `x-` namespace (e.g. `x-nps`).
 * Carried opaquely; the respondent renderer ignores + flags them, never crashes.
 * Promotion `x-*` → core requires an ADR + migrator.
 */
export interface CustomField extends FieldBase {
  type: `x-${string}`;
  config?: Record<string, unknown>;
  validation?: Record<string, unknown>;
}

export type FormField =
  | ShortTextField
  | LongTextField
  | EmailField
  | NumberField
  | PhoneField
  | DropdownField
  | RadioField
  | CheckboxField
  | DateField
  | TimeField
  | FileField
  | HiddenField
  | CustomField;

/* ------------------------------------------------------------------ */
/* Layout: pages → sections → fields (fields referenced inline)         */
/* ------------------------------------------------------------------ */

export interface FormSection {
  id: string;
  key: string;
  title?: string;
  fields: FormField[];
}
export interface FormPage {
  id: string;
  key: string;
  title?: string;
  sections: FormSection[];
}

/* ------------------------------------------------------------------ */
/* Rules: declarative conditions + actions (interpreter-owned)          */
/* ------------------------------------------------------------------ */

export type ConditionOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "not_contains"
  | "empty"
  | "not_empty"
  | "in"
  | "not_in";

/** A condition references another field by stable `key` — never by index. */
export interface Condition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}
export type ConditionGroup = { all: Condition[] } | { any: Condition[] };

export type RuleActionKind = "show" | "hide" | "require" | "optional" | "set" | "goto_page";
export interface RuleAction {
  /** Target field `key` (or page `key` for `goto_page`). */
  target: string;
  kind: RuleActionKind;
  value?: unknown;
}

export type RuleWhen = "show" | "hide" | "require" | "set_value" | "skip_page";
export interface Rule {
  /** Stable rule id. */
  id: string;
  when: RuleWhen;
  if: ConditionGroup;
  actions: RuleAction[];
}

/* ------------------------------------------------------------------ */
/* Calculations: serializable AST (never strings, never executable)     */
/* ------------------------------------------------------------------ */

export type CalcNode =
  | { kind: "lit"; value: number | string | boolean }
  | { kind: "ref"; field: string }
  | {
      kind: "binary";
      op: "+" | "-" | "*" | "/" | "%" | ">" | ">=" | "<" | "<=" | "==" | "!=";
      left: CalcNode;
      right: CalcNode;
    }
  | {
      kind: "call";
      fn: "SUM" | "AVG" | "MIN" | "MAX" | "ROUND" | "IF" | "CONCAT" | "DATE_DIFF";
      args: CalcNode[];
    };

export interface Calculation {
  /** Stable calc id. */
  id: string;
  /** Target field `key` receiving the computed value. */
  target: string;
  expression: CalcNode;
  /** Declared dependency keys — must equal the refs found in `expression`. */
  deps: string[];
}

/* ------------------------------------------------------------------ */
/* Form document                                                       */
/* ------------------------------------------------------------------ */

export interface FormSettings {
  captcha?: boolean;
  saveContinue?: boolean;
  offline?: boolean;
}

export interface CanonicalForm {
  id: string;
  key: string;
  /** Canonical contract version. Parse → migrate → validate; never mutate in place. */
  schemaVersion: number;
  /** Renderer compatibility/build tag, e.g. "rjsf-6.11+drv1". Informational only. */
  rendererVersion: string;
  metadata: {
    title: string;
    description?: string;
    localeDefault?: string;
    owner?: string;
  };
  settings: FormSettings;
  themeRef?: string;
  pages: FormPage[];
  rules: Rule[];
  calculations: Calculation[];
  localization: Record<string, Record<string, string>>;
  notificationsRef: string | null;
  integrationsRef: string | null;
  /** Tombstoned field ids — answers retained under old `id` for history. */
  deletedIds?: string[];
  /** Explicit rename map `oldKey → newKey`. Silent renames are forbidden. */
  keyAliases?: Record<string, string>;
}

/** Immutable published snapshot: frozen at publish, never mutated in place. */
export interface PublishedSnapshot {
  publishedVersion: number;
  schemaHash: string;
  schema: CanonicalForm;
}
