import type { CanonicalForm, FormField } from "@formos/forms-engine";
import { iterFields, renderValue, type DisplayValue } from "../submissions/present";

/**
 * Tables v1 column model (Phase 8). Pure + client-safe: no I/O, no secrets.
 *
 * Column set = union of field keys across the pinned snapshots present in the
 * current result set, ordered by the latest version's canonical document
 * order with historical-only keys appended in first-seen order.
 * Header label/type comes from the latest snapshot containing that key.
 * Cells ALWAYS render through the row's own pinned snapshot field def —
 * a newer label/type never reinterprets an older payload.
 */

export interface VersionSnapshot {
  id: string;
  publishedVersionNo: number;
  snapshot: CanonicalForm;
}

export interface TableColumn {
  key: string;
  label: string;
  type: string;
}

export function deriveColumns(versions: VersionSnapshot[]): TableColumn[] {
  const ordered = [...versions].sort((a, b) => b.publishedVersionNo - a.publishedVersionNo);
  const seen = new Map<string, TableColumn>();
  for (const v of ordered) {
    for (const field of iterFields(v.snapshot)) {
      if (!seen.has(field.key)) {
        seen.set(field.key, { key: field.key, label: field.label, type: field.type });
      }
    }
  }
  return [...seen.values()];
}

/** Index a snapshot's fields by stable key (built once per version, not per cell). */
export function fieldIndex(snapshot: CanonicalForm): Map<string, FormField> {
  const map = new Map<string, FormField>();
  for (const field of iterFields(snapshot)) {
    if (!map.has(field.key)) map.set(field.key, field);
  }
  return map;
}

export interface CellText {
  text: string;
  href?: string;
  muted: boolean;
  /** Full value for tooltip when truncated. */
  title?: string;
}

/**
 * Compact cell rendering from an already-interpreted DisplayValue.
 * Interpretation stays in `renderValue` (single owner); this only truncates.
 */
export function formatCell(display: DisplayValue, maxLen = 48): CellText {
  const base = { href: display.href, muted: display.kind === "empty" || display.kind === "files" } as {
    href?: string;
    muted: boolean;
  };
  if (display.text.length <= maxLen) return { text: display.text, ...base };
  return { text: `${display.text.slice(0, maxLen)}…`, title: display.text, ...base };
}

/**
 * Render one table cell: resolve the field from the row's PINNED snapshot
 * (never the header/latest def), then interpret + compact.
 * Missing key (or missing snapshot) → empty, never reinterpreted.
 */
export function renderTableCell(
  pinnedField: FormField | undefined,
  value: unknown,
  maxLen = 48,
): CellText {
  if (pinnedField === undefined) return { text: "—", muted: true };
  return formatCell(renderValue(pinnedField, value), maxLen);
}
