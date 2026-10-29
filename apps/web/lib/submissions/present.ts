/**
 * Canonical-field-aware submission value presentation (Phase 7).
 * Pure + client-safe (no server-only imports): display metadata (labels,
 * option labels, field order) always derives from the pinned published
 * snapshot — never from payload contents or browser-supplied values.
 * React escapes all strings at render; links are built only from
 * validated values (email/phone regex), never raw hrefs.
 */
import type { CanonicalForm, FormField } from "@formos/forms-engine";

export type DisplayKind =
  | "text"
  | "email"
  | "phone"
  | "date"
  | "time"
  | "number"
  | "options"
  | "files"
  | "empty"
  | "unknown";

export interface DisplayValue {
  kind: DisplayKind;
  /** Plain-text rendering (safe for any context). */
  text: string;
  /** Set for email/phone kinds only, built from validated values. */
  href?: string;
  /** Resolved option labels for dropdown/radio/checkbox kinds. */
  labels?: string[];
  /** Unresolved raw values (unknown enum options, x- fields). */
  raw?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

function optionLabel(field: { config?: { options?: Array<{ value: string; label: string }> } }, value: string): string | null {
  const found = field.config?.options?.find((o) => o.value === value);
  return found ? found.label : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.every((v) => typeof v === "string")) return value as string[];
  return null;
}

/** Render one submitted value using its canonical field definition. */
export function renderValue(field: FormField, value: unknown): DisplayValue {
  if (value === null || value === undefined || value === "") {
    return { kind: "empty", text: "—" };
  }
  switch (field.type) {
    case "email": {
      if (typeof value === "string" && EMAIL_RE.test(value)) {
        return { kind: "email", text: value, href: `mailto:${value}` };
      }
      return { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    }
    case "phone": {
      if (typeof value === "string" && E164_RE.test(value.replace(/[\s\-().]/g, ""))) {
        const normalized = value.replace(/[\s\-().]/g, "");
        return { kind: "phone", text: value, href: `tel:${normalized}` };
      }
      return { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    }
    case "date": {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        // Calendar-day value: format in UTC so the day never shifts by TZ.
        const [y, m, d] = value.split("-").map(Number);
        const label = new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
        return { kind: "date", text: `${label} (${value})` };
      }
      return { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    }
    case "time":
      return { kind: "time", text: typeof value === "string" ? value : JSON.stringify(value) };
    case "number":
      return {
        kind: "number",
        text: typeof value === "number" ? value.toLocaleString("en-US") : typeof value === "string" ? value : JSON.stringify(value),
      };
    case "dropdown":
    case "radio": {
      if (typeof value === "string") {
        const label = optionLabel(field as { config?: { options?: Array<{ value: string; label: string }> } }, value);
        if (label !== null) return { kind: "options", text: label, labels: [label] };
        return { kind: "unknown", text: value, raw: value };
      }
      return { kind: "unknown", text: JSON.stringify(value), raw: value };
    }
    case "checkbox": {
      const values = asStringArray(value);
      if (values === null) return { kind: "unknown", text: JSON.stringify(value), raw: value };
      if (values.length === 0) return { kind: "empty", text: "—" };
      const labels = values.map(
        (v) => optionLabel(field as { config?: { options?: Array<{ value: string; label: string }> } }, v) ?? v,
      );
      return { kind: "options", text: labels.join(", "), labels };
    }
    case "file": {
      const values = asStringArray(value);
      const count = values?.length ?? 0;
      // The secure file pipeline is deferred: intake rejects non-empty refs,
      // so a live row can only hold []. Non-empty = placeholder, never a URL.
      if (count === 0) return { kind: "files", text: "No files" };
      return { kind: "files", text: `${count} file${count === 1 ? "" : "s"} — download unavailable` };
    }
    case "hidden":
    case "short_text":
    case "long_text":
      return { kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) };
    default:
      // x- extension fields: carried opaquely, flagged by kind.
      return { kind: "unknown", text: typeof value === "string" ? value : JSON.stringify(value), raw: value };
  }
}

/** Canonical document order: pages → sections → fields. */
export function iterFields(form: CanonicalForm): FormField[] {
  const out: FormField[] = [];
  for (const page of form.pages) {
    for (const section of page.sections) {
      for (const field of section.fields) out.push(field);
    }
  }
  return out;
}

/** Field keys holding free text (searchable via PostgREST ->> ilike). */
export function textSearchKeys(form: CanonicalForm): string[] {
  return iterFields(form)
    .filter((f) => f.type === "short_text" || f.type === "long_text" || f.type === "email" || f.type === "phone")
    .map((f) => f.key);
}

const SUMMARY_TYPES: ReadonlySet<string> = new Set([
  "short_text",
  "email",
  "phone",
  "number",
  "date",
  "dropdown",
  "radio",
]);

/**
 * Compact list summary: first two non-empty summary-eligible values in
 * document order. Never hardcodes field names. Falls back to a stable
 * generic label when nothing qualifies.
 */
export function summarizeSubmission(
  form: CanonicalForm,
  payload: Record<string, unknown>,
): { primary: string; secondary: string | null } {
  const shown: string[] = [];
  for (const field of iterFields(form)) {
    if (!SUMMARY_TYPES.has(field.type)) continue;
    const rendered = renderValue(field, payload[field.key]);
    if (rendered.kind === "empty") continue;
    // Keep list rows compact: truncate long text.
    shown.push(rendered.text.length > 60 ? `${rendered.text.slice(0, 60)}…` : rendered.text);
    if (shown.length >= 2) break;
  }
  if (shown.length === 0) return { primary: "Submission", secondary: null };
  return { primary: shown[0] as string, secondary: shown[1] ?? null };
}

/** Format an ISO timestamp for display (UTC, deterministic for tests). */
export function formatTimestamp(iso: string): string {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(dt);
}
