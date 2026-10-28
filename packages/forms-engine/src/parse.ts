/**
 * Canonical parser: parse → detect schemaVersion → migrate → validate.
 *
 * Zod is used here ONLY as the parsing tool for the canonical contract itself.
 * The persisted representation is plain JSON conforming to `schema.ts` — Zod
 * schemas are never stored, and this module never reverses a derivation.
 */
import { z } from "zod";
import { CanonicalError, migrateToCurrent } from "./migrate.js";
import {
  MVP_FIELD_TYPES,
  type CanonicalForm,
  type FormField,
} from "./schema.js";

const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9_]{1,64}$/, "must be a stable slug [a-z0-9_]{1,64}");
const nonEmpty = z.string().min(1);

const optionSchema = z
  .object({ value: nonEmpty, label: nonEmpty, description: z.string().optional() })
  .strict();
const optionsSchema = z
  .array(optionSchema)
  .min(1, "choice fields require at least one option")
  .refine((opts) => new Set(opts.map((o) => o.value)).size === opts.length, "option values must be unique");

const baseField = {
  id: uuid,
  key: slug,
  label: nonEmpty,
  description: z.string().optional(),
  required: z.boolean(),
  hidden: z.boolean().optional(),
  default: z.unknown(),
  presentation: z
    .object({ placeholder: z.string().optional(), width: z.enum(["full", "half", "third"]).optional() })
    .strict()
    .optional(),
};

const shortText = z.object({ ...baseField, type: z.literal("short_text"), config: z.record(z.never()).optional(), validation: z.object({ minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(1).optional(), pattern: z.string().min(1).optional() }).strict().optional() });
const longText = z.object({ ...baseField, type: z.literal("long_text"), config: z.record(z.never()).optional(), validation: z.object({ minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(1).optional(), pattern: z.string().min(1).optional() }).strict().optional() });
const emailF = z.object({ ...baseField, type: z.literal("email"), config: z.record(z.never()).optional(), validation: z.object({ kind: z.literal("email").optional() }).strict().optional() });
const numberF = z.object({ ...baseField, type: z.literal("number"), config: z.record(z.never()).optional(), validation: z.object({ min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() }).strict().optional() });
const phoneF = z.object({ ...baseField, type: z.literal("phone"), config: z.record(z.never()).optional(), validation: z.object({ region: z.string().min(1).optional() }).strict().optional() });
const dropdownF = z.object({ ...baseField, type: z.literal("dropdown"), config: z.object({ options: optionsSchema }).strict(), validation: z.object({ kind: z.literal("choice").optional() }).strict().optional() });
const radioF = z.object({ ...baseField, type: z.literal("radio"), config: z.object({ options: optionsSchema }).strict(), validation: z.object({ kind: z.literal("choice").optional() }).strict().optional() });
const checkboxF = z.object({ ...baseField, type: z.literal("checkbox"), config: z.object({ options: optionsSchema }).strict(), validation: z.object({ minItems: z.number().int().min(0).optional(), maxItems: z.number().int().min(1).optional() }).strict().optional() });
const dateF = z.object({ ...baseField, type: z.literal("date"), config: z.record(z.never()).optional(), validation: z.object({ min: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), max: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notPast: z.boolean().optional(), notFuture: z.boolean().optional() }).strict().optional() });
const timeF = z.object({ ...baseField, type: z.literal("time"), config: z.record(z.never()).optional(), validation: z.object({ min: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), max: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() }).strict().optional() });
const fileF = z.object({ ...baseField, type: z.literal("file"), config: z.record(z.never()).optional(), validation: z.object({ maxMB: z.number().positive(), mime: z.array(nonEmpty).min(1), maxCount: z.number().int().min(1) }).strict() });
const hiddenF = z.object({ ...baseField, type: z.literal("hidden"), config: z.record(z.never()).optional(), validation: z.record(z.never()).optional(), prefill: z.object({ source: z.enum(["query", "auth"]), path: nonEmpty }).strict().optional() });
const customF = z.object({
  ...baseField,
  type: z.string().regex(/^x-[a-z0-9-]+$/, "custom types must use the x- namespace"),
  config: z.record(z.unknown()).optional(),
  validation: z.record(z.unknown()).optional(),
});

const fieldSchema: z.ZodTypeAny = z.union([
  shortText, longText, emailF, numberF, phoneF, dropdownF, radioF, checkboxF, dateF, timeF, fileF, hiddenF, customF,
]);

const conditionSchema = z
  .object({
    field: slug,
    op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "empty", "not_empty", "in", "not_in"]),
    value: z.unknown(),
  })
  .strict();
const conditionGroupSchema = z.union([z.object({ all: z.array(conditionSchema).min(1) }).strict(), z.object({ any: z.array(conditionSchema).min(1) }).strict()]);
const ruleActionSchema = z
  .object({ target: slug, kind: z.enum(["show", "hide", "require", "optional", "set", "goto_page"]), value: z.unknown() })
  .strict();
const ruleSchema = z
  .object({
    id: nonEmpty,
    when: z.enum(["show", "hide", "require", "set_value", "skip_page"]),
    if: conditionGroupSchema,
    actions: z.array(ruleActionSchema).min(1),
  })
  .strict();

const calcNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("lit"), value: z.union([z.number(), z.string(), z.boolean()]) }).strict(),
    z.object({ kind: z.literal("ref"), field: slug }).strict(),
    z
      .object({
        kind: z.literal("binary"),
        op: z.enum(["+", "-", "*", "/", "%", ">", ">=", "<", "<=", "==", "!="]),
        left: calcNodeSchema,
        right: calcNodeSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("call"),
        fn: z.enum(["SUM", "AVG", "MIN", "MAX", "ROUND", "IF", "CONCAT", "DATE_DIFF"]),
        args: z.array(calcNodeSchema).min(1),
      })
      .strict(),
  ]),
);
const calculationSchema = z
  .object({ id: nonEmpty, target: slug, expression: calcNodeSchema, deps: z.array(slug) })
  .strict();

const sectionSchema = z
  .object({ id: uuid, key: slug, title: nonEmpty.optional(), fields: z.array(fieldSchema).min(1) })
  .strict();
const pageSchema = z
  .object({ id: uuid, key: slug, title: nonEmpty.optional(), sections: z.array(sectionSchema).min(1) })
  .strict();

const formSchemaV1 = z
  .object({
    id: uuid,
    key: slug,
    schemaVersion: z.number(),
    rendererVersion: nonEmpty,
    metadata: z
      .object({
        title: nonEmpty,
        description: z.string().optional(),
        localeDefault: z.string().min(1).optional(),
        owner: z.string().min(1).optional(),
      })
      .strict(),
    settings: z
      .object({ captcha: z.boolean().optional(), saveContinue: z.boolean().optional(), offline: z.boolean().optional() })
      .strict(),
    themeRef: z.string().min(1).optional(),
    pages: z.array(pageSchema).min(1),
    rules: z.array(ruleSchema),
    calculations: z.array(calculationSchema),
    localization: z.record(z.record(z.string())),
    notificationsRef: z.string().nullable(),
    integrationsRef: z.string().nullable(),
    deletedIds: z.array(uuid).optional(),
    keyAliases: z.record(slug).optional(),
  })
  .strict();

function allFields(form: CanonicalForm): FormField[] {
  return form.pages.flatMap((p) => p.sections.flatMap((s) => s.fields));
}

/** Semantic checks that structural parsing alone cannot express. */
function checkSemantics(form: CanonicalForm): void {
  const fail = (message: string): never => {
    throw new CanonicalError("semantic", message);
  };
  const fields = allFields(form);
  const ids = new Set<string>();
  for (const f of fields) {
    if (ids.has(f.id)) fail(`duplicate field id: ${f.id}`);
    ids.add(f.id);
  }
  const keys = new Set<string>();
  for (const f of fields) {
    if (keys.has(f.key)) fail(`duplicate field key: ${f.key}`);
    keys.add(f.key);
  }
  const ruleIds = new Set<string>();
  for (const r of form.rules) {
    if (ruleIds.has(r.id)) fail(`duplicate rule id: ${r.id}`);
    ruleIds.add(r.id);
  }
  // Range/consistency sanity per field (invalid field configuration).
  for (const f of fields) {
    if ((f.type === "short_text" || f.type === "long_text") && f.validation) {
      const { minLength, maxLength } = f.validation;
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        fail(`field ${f.key}: minLength exceeds maxLength`);
      }
    }
    if (f.type === "number" && f.validation) {
      const { min, max } = f.validation;
      if (min !== undefined && max !== undefined && min > max) fail(`field ${f.key}: min exceeds max`);
    }
    if (f.type === "checkbox" && f.validation) {
      const { minItems, maxItems } = f.validation;
      if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
        fail(`field ${f.key}: minItems exceeds maxItems`);
      }
      if (f.required && minItems === 0) fail(`field ${f.key}: required with minItems 0`);
    }
    if (f.type === "date" && f.validation) {
      const { min, max } = f.validation;
      if (min !== undefined && max !== undefined && min > max) fail(`field ${f.key}: min exceeds max`);
    }
    if (f.type === "time" && f.validation) {
      const { min, max } = f.validation;
      if (min !== undefined && max !== undefined && min > max) fail(`field ${f.key}: min exceeds max`);
    }
  }
  const calcIds = new Set<string>();
  for (const c of form.calculations) {
    if (calcIds.has(c.id)) fail(`duplicate calculation id: ${c.id}`);
    calcIds.add(c.id);
  }
  const conds = form.rules.flatMap((r) => ("all" in r.if ? r.if.all : r.if.any));
  for (const c of conds) {
    if (!keys.has(c.field)) fail(`rule references unknown field key: ${c.field}`);
  }
  const pageKeys = new Set(form.pages.map((p) => p.key));
  for (const r of form.rules) {
    for (const a of r.actions) {
      if (a.kind === "goto_page") {
        if (!pageKeys.has(a.target)) fail(`rule references unknown page key: ${a.target}`);
      } else if (!keys.has(a.target)) {
        fail(`rule action targets unknown field key: ${a.target}`);
      }
    }
  }
  for (const c of form.calculations) {
    if (!keys.has(c.target)) fail(`calculation targets unknown field key: ${c.target}`);
    if (refsOf(c.expression).includes(c.target)) fail(`calculation writes its own dependency: ${c.target}`);
    const found = [...new Set(refsOf(c.expression))].sort();
    const declared = [...new Set(c.deps)].sort();
    for (const r of found) {
      if (!keys.has(r)) fail(`calculation references unknown field key: ${r}`);
    }
    if (JSON.stringify(found) !== JSON.stringify(declared)) {
      fail(`calculation deps mismatch for target ${c.target}: declared [${declared}] vs referenced [${found}]`);
    }
  }
}

function refsOf(node: { kind: string; field?: string; left?: unknown; right?: unknown; args?: unknown[] }): string[] {
  if (node.kind === "ref" && typeof node.field === "string") return [node.field];
  if (node.kind === "binary") {
    return [
      ...refsOf(node.left as { kind: string }),
      ...refsOf(node.right as { kind: string }),
    ];
  }
  if (node.kind === "call" && Array.isArray(node.args)) {
    return (node.args as Array<{ kind: string }>).flatMap(refsOf);
  }
  return [];
}

/**
 * Parse + migrate + validate unknown input into a CanonicalForm.
 * Throws CanonicalError (`invalid_shape` | `unsupported_version` | `semantic`).
 */
export function parseCanonicalForm(input: unknown): CanonicalForm {
  const { doc } = migrateToCurrent(input);
  const raw = doc as Record<string, unknown>;
  if (typeof raw["type"] === "undefined" && Array.isArray(raw["pages"])) {
    const pages = raw["pages"] as Array<Record<string, unknown>>;
    for (const [pageIndex, page] of pages.entries()) {
      const sections = (page["sections"] as Array<Record<string, unknown>>) ?? [];
      for (const [sectionIndex, section] of sections.entries()) {
        const fields = (section["fields"] as Array<Record<string, unknown>>) ?? [];
        for (const [fieldIndex, field] of fields.entries()) {
          const t = field["type"];
          if (typeof t !== "string") {
            throw new CanonicalError("invalid_shape", `pages.${pageIndex}.sections.${sectionIndex}.fields.${fieldIndex}: every field requires a type`);
          }
          if (!(MVP_FIELD_TYPES as readonly string[]).includes(t) && !t.startsWith("x-")) {
            throw new CanonicalError(
              "semantic",
              `pages.${pageIndex}.sections.${sectionIndex}.fields.${fieldIndex}: unknown field type: ${t} (MVP-12 or x- namespace required)`,
            );
          }
        }
      }
    }
  }
  const parsed = formSchemaV1.safeParse(doc);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.map(String).join(".") || "(root)";
    throw new CanonicalError("invalid_shape", `${path}: ${first?.message ?? "invalid"}`);
  }
  const form = parsed.data as CanonicalForm;
  checkSemantics(form);
  return form;
}

/** All fields in document order (pages → sections → fields). */
export function collectFields(form: CanonicalForm): FormField[] {
  return allFields(form);
}

/** Index fields by stable `key` for reference resolution. */
export function indexFieldsByKey(form: CanonicalForm): Map<string, FormField> {
  return new Map(allFields(form).map((f) => [f.key, f]));
}
