/**
 * Canonical document operations — the ONLY way the builder mutates a form.
 * Every operation takes a CanonicalForm, returns a NEW CanonicalForm
 * (structuredClone; never mutates inputs), and re-validates the result with
 * `parseCanonicalForm` so the editor can never construct an unpersistable
 * document. IDs are generated here (never client-chosen, never reused);
 * keys are derived + uniquified here.
 */
import {
  parseCanonicalForm,
  type CanonicalForm,
  type FormField,
  type MvpFieldType,
} from "@formos/forms-engine";
import { FIELD_CAPABILITIES, createDefaultField } from "./capabilities.js";

/** Stable UUID for a new field. Never reused, never client-chosen. */
export function newFieldId(): string {
  return crypto.randomUUID();
}

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return base || "field";
}

function allKeys(doc: CanonicalForm): Set<string> {
  const keys = new Set<string>();
  for (const page of doc.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) keys.add(field.key);
    }
  }
  return keys;
}

/** Derive a unique stable key from a label (suffixes on collision). */
export function uniqueKey(doc: CanonicalForm, label: string): string {
  const taken = allKeys(doc);
  const base = slugify(label);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

function clone(doc: CanonicalForm): CanonicalForm {
  return structuredClone(doc);
}

function checked(doc: CanonicalForm): CanonicalForm {
  return parseCanonicalForm(doc);
}

export interface FieldLocation {
  pageIndex: number;
  sectionIndex: number;
  fieldIndex: number;
}

export function findFieldLocation(doc: CanonicalForm, fieldId: string): FieldLocation | null {
  for (const [pageIndex, page] of doc.pages.entries()) {
    for (const [sectionIndex, section] of page.sections.entries()) {
      const fieldIndex = section.fields.findIndex((f) => f.id === fieldId);
      if (fieldIndex !== -1) return { pageIndex, sectionIndex, fieldIndex };
    }
  }
  return null;
}

export function listFields(doc: CanonicalForm): FormField[] {
  return doc.pages.flatMap((p) => p.sections.flatMap((s) => s.fields));
}

export interface AddFieldTarget {
  pageKey?: string;
  sectionKey?: string;
  /** Insert after this field (its section wins over sectionKey). */
  afterFieldId?: string;
}

/** Append a minimal valid field; returns the new doc + the created field. */
export function addField(
  doc: CanonicalForm,
  type: MvpFieldType,
  target: AddFieldTarget = {},
  opts: { label?: string } = {},
): { doc: CanonicalForm; field: FormField } {
  const next = clone(doc);
  const capability = FIELD_CAPABILITIES[type];
  const label = opts.label ?? capability.defaultLabel;
  const field = createDefaultField(type, newFieldId(), uniqueKey(next, label), label);

  let page = next.pages[0];
  if (!page) throw new Error("document has no pages");
  let section = page.sections[0];
  if (!section) throw new Error("document has no sections");
  let index = section.fields.length;

  if (target.afterFieldId !== undefined) {
    const at = findFieldLocation(next, target.afterFieldId);
    if (!at) throw new Error(`anchor field not found: ${target.afterFieldId}`);
    page = next.pages[at.pageIndex];
    if (!page) throw new Error("anchor page missing");
    section = page.sections[at.sectionIndex];
    if (!section) throw new Error("anchor section missing");
    index = at.fieldIndex + 1;
  } else {
    if (target.pageKey !== undefined) {
      const found = next.pages.find((p) => p.key === target.pageKey);
      if (!found) throw new Error(`page not found: ${target.pageKey}`);
      page = found;
    }
    if (target.sectionKey !== undefined) {
      const found = page.sections.find((s) => s.key === target.sectionKey);
      if (!found) throw new Error(`section not found: ${target.sectionKey}`);
      section = found;
      index = section.fields.length;
    }
  }
  section.fields.splice(index, 0, field);
  return { doc: checked(next), field };
}

export interface FieldPatch {
  label?: string;
  description?: string | null;
  required?: boolean;
  hidden?: boolean;
  placeholder?: string | null;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  /** Partial per-type validation; keys must be editable for the field type. */
  validation?: Record<string, unknown>;
}

function checkDefaultType(field: FormField, value: unknown): void {
  if (value === undefined) return;
  const ok =
    field.type === "number"
      ? typeof value === "number"
      : field.type === "checkbox" || field.type === "file"
        ? Array.isArray(value)
        : typeof value === "string";
  if (!ok) throw new Error(`default value type mismatch for ${field.type}`);
}

/** Patch a field's editable properties; structural validity re-checked on save. */
export function updateField(doc: CanonicalForm, fieldId: string, patch: FieldPatch): { doc: CanonicalForm } {
  const next = clone(doc);
  const at = findFieldLocation(next, fieldId);
  if (!at) throw new Error(`field not found: ${fieldId}`);
  const page = next.pages[at.pageIndex];
  const section = page?.sections[at.sectionIndex];
  const field = section?.fields[at.fieldIndex];
  if (!field) throw new Error(`field not found: ${fieldId}`);
  const capability = FIELD_CAPABILITIES[field.type as MvpFieldType];

  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new Error("label is required");
    field.label = label;
  }
  if (patch.description !== undefined) {
    if (patch.description === null || patch.description === "") delete field.description;
    else field.description = patch.description;
  }
  if (patch.required !== undefined) field.required = patch.required;
  if (patch.hidden !== undefined) {
    if (patch.hidden) field.hidden = true;
    else delete field.hidden;
  }
  if (patch.placeholder !== undefined) {
    if (!capability || !capability.supportsPlaceholder) throw new Error(`placeholder not supported for ${field.type}`);
    const current = field.presentation?.placeholder;
    if (patch.placeholder !== (current ?? null)) {
      if (patch.placeholder === null || patch.placeholder === "") {
        const { placeholder: _dropped, ...rest } = field.presentation ?? {};
        void _dropped;
        if (Object.keys(rest).length === 0) delete field.presentation;
        else field.presentation = rest;
      } else {
        field.presentation = { ...(field.presentation ?? {}), placeholder: patch.placeholder };
      }
    }
  }
  if (patch.options !== undefined) {
    if (!capability || !capability.supportsOptions) throw new Error(`options not supported for ${field.type}`);
    if (field.type !== "dropdown" && field.type !== "radio" && field.type !== "checkbox") {
      throw new Error(`options not supported for ${field.type}`);
    }
    const seen = new Set<string>();
    for (const option of patch.options) {
      if (option.value.trim() === "" || seen.has(option.value)) throw new Error("option values must be unique and non-empty");
      seen.add(option.value);
      if (option.label.trim() === "") throw new Error("option labels are required");
    }
    field.config = { options: patch.options.map((o) => ({ value: o.value, label: o.label })) };
  }
  if ("default" in patch) {
    checkDefaultType(field, patch.default);
    if (patch.default === undefined) delete field.default;
    else field.default = patch.default;
  }
  if (patch.validation !== undefined) {
    const allowed = new Set<string>(capability ? capability.editableConstraints : []);
    for (const key of Object.keys(patch.validation)) {
      if (!allowed.has(key)) throw new Error(`constraint not editable for ${field.type}: ${key}`);
    }
    const current = (field as { validation?: Record<string, unknown> }).validation ?? {};
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...current, ...patch.validation })) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
    (field as { validation?: Record<string, unknown> }).validation = merged;
  }
  return { doc: checked(next) };
}

/** Move a field up/down within its section. Returns whether anything moved. */
export function moveField(doc: CanonicalForm, fieldId: string, direction: "up" | "down"): { doc: CanonicalForm; moved: boolean } {
  const next = clone(doc);
  const at = findFieldLocation(next, fieldId);
  if (!at) throw new Error(`field not found: ${fieldId}`);
  const fields = next.pages[at.pageIndex]?.sections[at.sectionIndex]?.fields;
  if (!fields) throw new Error(`field not found: ${fieldId}`);
  const swapWith = direction === "up" ? at.fieldIndex - 1 : at.fieldIndex + 1;
  if (swapWith < 0 || swapWith >= fields.length) return { doc, moved: false };
  const current = fields[at.fieldIndex];
  const other = fields[swapWith];
  if (current === undefined || other === undefined) return { doc, moved: false };
  fields[at.fieldIndex] = other;
  fields[swapWith] = current;
  return { doc: checked(next), moved: true };
}

/** Move a field to an explicit section/index (same page or cross-section). */
export function moveFieldTo(
  doc: CanonicalForm,
  fieldId: string,
  target: { pageKey: string; sectionKey: string; index: number },
): { doc: CanonicalForm } {
  const next = clone(doc);
  const at = findFieldLocation(next, fieldId);
  if (!at) throw new Error(`field not found: ${fieldId}`);
  const from = next.pages[at.pageIndex]?.sections[at.sectionIndex]?.fields;
  if (!from) throw new Error(`field not found: ${fieldId}`);
  const [field] = from.splice(at.fieldIndex, 1);
  if (!field) throw new Error(`field not found: ${fieldId}`);
  const page = next.pages.find((p) => p.key === target.pageKey);
  if (!page) throw new Error(`page not found: ${target.pageKey}`);
  const section = page.sections.find((s) => s.key === target.sectionKey);
  if (!section) throw new Error(`section not found: ${target.sectionKey}`);
  const index = Math.max(0, Math.min(target.index, section.fields.length));
  section.fields.splice(index, 0, field);
  return { doc: checked(next) };
}

export interface DeleteBlocker {
  kind: "rule" | "calculation";
  id: string;
}

function ruleRefs(doc: CanonicalForm): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const rule of doc.rules) {
    const conds = "all" in rule.if ? rule.if.all : rule.if.any;
    for (const cond of conds) {
      const list = refs.get(cond.field) ?? [];
      list.push(`rule:${rule.id}`);
      refs.set(cond.field, list);
    }
    for (const action of rule.actions) {
      if (action.kind === "goto_page") continue;
      const list = refs.get(action.target) ?? [];
      list.push(`rule:${rule.id}`);
      refs.set(action.target, list);
    }
  }
  return refs;
}

export type DeleteResult = { ok: true; doc: CanonicalForm } | { ok: false; blockers: DeleteBlocker[] };

/**
 * Delete a field deliberately: referenced keys BLOCK deletion (returned, never
 * silently corrupted); otherwise the field is removed and its id is tombstoned
 * in `deletedIds` so historical answers stay attributable.
 */
export function deleteField(doc: CanonicalForm, fieldId: string): DeleteResult {
  const at = findFieldLocation(doc, fieldId);
  if (!at) throw new Error(`field not found: ${fieldId}`);
  const field = doc.pages[at.pageIndex]?.sections[at.sectionIndex]?.fields[at.fieldIndex];
  if (!field) throw new Error(`field not found: ${fieldId}`);

  const blockers: DeleteBlocker[] = [];
  const refs = ruleRefs(doc);
  for (const owner of refs.get(field.key) ?? []) {
    const [kind, ...rest] = owner.split(":");
    blockers.push({ kind: kind === "calculation" ? "calculation" : "rule", id: rest.join(":") });
  }
  for (const calc of doc.calculations) {
    const uses = JSON.stringify(calc.expression).includes(`"field":"${field.key}"`);
    if (calc.target === field.key || uses) blockers.push({ kind: "calculation", id: calc.id });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  const next = clone(doc);
  const from = next.pages[at.pageIndex]?.sections[at.sectionIndex]?.fields;
  if (!from) throw new Error(`field not found: ${fieldId}`);
  from.splice(at.fieldIndex, 1);
  next.deletedIds = [...(next.deletedIds ?? []), fieldId];
  return { ok: true, doc: checked(next) };
}

export interface DocumentIssue {
  /** Canonical stable field id when the error path resolves to one. */
  fieldId?: string;
  message: string;
}

/** Validate a candidate document; maps parse paths back to field ids where possible. */
export function validateDocument(input: unknown): { ok: true; doc: CanonicalForm } | { ok: false; issues: DocumentIssue[] } {
  try {
    return { ok: true, doc: parseCanonicalForm(input) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid form document.";
    const fieldId = fieldIdFromMessage(input, message);
    return { ok: false, issues: [{ ...(fieldId !== undefined ? { fieldId } : {}), message }] };
  }
}

function fieldIdFromMessage(input: unknown, message: string): string | undefined {
  const match = /pages\.(\d+)\.sections\.(\d+)\.fields\.(\d+)/.exec(message);
  if (!match) return undefined;
  const [, pageIndex, sectionIndex, fieldIndex] = match.map(Number) as [string, number, number, number];
  try {
    const doc = input as { pages?: Array<{ sections?: Array<{ fields?: Array<{ id?: string }> }> }> };
    return doc.pages?.[pageIndex]?.sections?.[sectionIndex]?.fields?.[fieldIndex]?.id;
  } catch {
    return undefined;
  }
}
