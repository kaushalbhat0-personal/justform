/**
 * FORMOS → Zod (application validation authority — client AND server share
 * this single generator; divergence is a P0 bug).
 *
 * Normalization contract: generated schemas produce normalized submission
 * values — canonical defaults fill absent inputs, phone values are
 * formatting-normalized, untouched optional strings collapse `""` → undefined.
 */
import { z } from "zod";
import type { CanonicalForm, FormField } from "./schema.js";
import { indexFieldsByKey } from "./parse.js";
import { toFormValidationErrors, type FormValidationError } from "./errors.js";

const E164 = /^\+[1-9]\d{7,14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function normalizePhone(value: string): string {
  return value.replace(/[\s\-().]/g, "");
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function todayUTC(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `""` (untouched optional input) collapses to undefined before validation. */
function emptyToUndefined<T extends z.ZodTypeAny>(inner: T): z.ZodTypeAny {
  return z.preprocess((v) => (v === "" ? undefined : v), inner);
}

function applyDefaultAndOptional(schema: z.ZodTypeAny, field: FormField): z.ZodTypeAny {
  if (field.default !== undefined) return schema.default(field.default);
  if (!field.required) return emptyToUndefined(schema.optional());
  return schema;
}

function stringField(inner: z.ZodTypeAny, field: FormField): z.ZodTypeAny {
  return applyDefaultAndOptional(inner, field);
}

function schemaForField(field: FormField): z.ZodTypeAny {
  switch (field.type) {
    case "short_text":
    case "long_text": {
      const v = field.validation ?? {};
      let s = z.string();
      if (v.minLength !== undefined) s = s.min(v.minLength);
      if (v.maxLength !== undefined) s = s.max(v.maxLength);
      if (v.pattern !== undefined) s = s.regex(new RegExp(v.pattern));
      return stringField(s, field);
    }
    case "email":
      return stringField(z.string().email(), field);
    case "number": {
      const v = field.validation ?? {};
      let s = z.number();
      if (v.integer === true) s = s.int();
      if (v.min !== undefined) s = s.min(v.min);
      if (v.max !== undefined) s = s.max(v.max);
      return applyDefaultAndOptional(s, field);
    }
    case "phone": {
      const s = z
        .string()
        .transform((v) => normalizePhone(v))
        .refine((v) => E164.test(v), { message: "phone must be E.164 (e.g. +61412345678)" });
      return applyDefaultAndOptional(s, field);
    }
    case "dropdown":
    case "radio": {
      const values = field.config.options.map((o) => o.value);
      const s = z.enum([values[0] as string, ...values.slice(1)]);
      return applyDefaultAndOptional(s, field);
    }
    case "checkbox": {
      const v = field.validation ?? {};
      const values = field.config.options.map((o) => o.value);
      const item = z.enum([values[0] as string, ...values.slice(1)]);
      let s = z.array(item);
      const minItems = v.minItems ?? (field.required ? 1 : undefined);
      if (minItems !== undefined) s = s.min(minItems);
      if (v.maxItems !== undefined) s = s.max(v.maxItems);
      return applyDefaultAndOptional(s, field);
    }
    case "date": {
      const v = field.validation ?? {};
      // NOTE: notPast/notFuture compare against the UTC calendar day; a
      // submission straddling midnight UTC between client and server is an
      // accepted day-boundary caveat (documented, not silent).
      let s: z.ZodTypeAny = z
        .string()
        .refine(isRealDate, { message: "date must be a real calendar date (YYYY-MM-DD)" });
      if (v.min !== undefined) {
        const min = v.min;
        s = s.refine((d) => d >= min, { message: `date must be on or after ${min}` });
      }
      if (v.max !== undefined) {
        const max = v.max;
        s = s.refine((d) => d <= max, { message: `date must be on or before ${max}` });
      }
      if (v.notPast === true) s = s.refine((d) => d >= todayUTC(), { message: "date must not be in the past" });
      if (v.notFuture === true) s = s.refine((d) => d <= todayUTC(), { message: "date must not be in the future" });
      return stringField(s, field);
    }
    case "time": {
      const v = field.validation ?? {};
      let s: z.ZodTypeAny = z.string().regex(TIME_RE, { message: "time must be HH:MM (24h)" });
      if (v.min !== undefined) {
        const min = v.min;
        s = s.refine((d) => d >= min, { message: `time must be on or after ${min}` });
      }
      if (v.max !== undefined) {
        const max = v.max;
        s = s.refine((d) => d <= max, { message: `time must be on or before ${max}` });
      }
      return stringField(s, field);
    }
    case "file": {
      const v = field.validation;
      let s = z.array(z.string().uuid()).max(v.maxCount);
      if (field.required) s = s.min(1);
      return applyDefaultAndOptional(s, field);
    }
    case "hidden":
      return stringField(z.string(), field);
    default:
      // `x-` extensions: passthrough at the validation layer; the renderer
      // ignores + flags them. Unknown shapes never block sibling fields.
      return applyDefaultAndOptional(z.unknown(), field);
  }
}

/**
 * Generate the application Zod object schema from the canonical form.
 * Pure + deterministic: keys in document order.
 */
export function generateZod(form: CanonicalForm): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const page of form.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) {
        shape[field.key] = schemaForField(field);
      }
    }
  }
  return z.object(shape).strict();
}

export type SubmissionSuccess = { ok: true; values: Record<string, unknown> };
export type SubmissionFailure = { ok: false; errors: FormValidationError[] };

/**
 * Validate raw submission values against the canonical-derived Zod schema.
 * The SAME function runs client-side (submit gate) and server-side (pre-RPC);
 * agreement is structural, not coincidental.
 */
export function validateSubmission(form: CanonicalForm, values: unknown): SubmissionSuccess | SubmissionFailure {
  const schema = generateZod(form);
  const parsed = schema.safeParse(values);
  if (parsed.success) return { ok: true, values: parsed.data as Record<string, unknown> };
  const byKey = indexFieldsByKey(form);
  return { ok: false, errors: toFormValidationErrors(parsed.error.issues, byKey) };
}
