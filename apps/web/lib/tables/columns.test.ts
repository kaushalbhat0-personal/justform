import { describe, expect, it } from "vitest";
import { contactExample } from "@formos/forms-engine";
import type { CanonicalForm } from "@formos/forms-engine";
import { deriveColumns, fieldIndex, formatCell, renderTableCell } from "./columns";
import { iterFields } from "../submissions/present";

const v1 = contactExample();
const v2: CanonicalForm = JSON.parse(JSON.stringify(v1)) as CanonicalForm;
// v2: rename name label, drop topic, add email-note field.
for (const field of iterFields(v2)) {
  if (field.key === "full_name") field.label = "Your full name";
}
const mainPage = v2.pages[0];
const mainSection = mainPage?.sections[0];
if (!mainPage || !mainSection) throw new Error("fixture malformed");
mainSection.fields = iterFields(v2).filter((f) => f.key !== "topic");
mainSection.fields.push({
  id: "00000000-0000-4000-8000-000000000099",
  key: "email_note",
  type: "short_text",
  label: "Email note",
  required: false,
} as never);

const snap = (publishedVersionNo: number, snapshot: CanonicalForm) => ({
  id: `ver-${publishedVersionNo}`,
  publishedVersionNo,
  snapshot,
});

describe("deriveColumns", () => {
  it("orders by latest canonical document order, latest label wins", () => {
    const cols = deriveColumns([snap(1, v1), snap(2, v2)]);
    const keys = cols.map((c) => c.key);
    // topic survives (v1-only), email_note appended after v2 order.
    expect(keys).toContain("full_name");
    expect(keys).toContain("topic");
    expect(keys).toContain("email_note");
    expect(keys.indexOf("topic")).toBeGreaterThan(keys.indexOf("full_name"));
    expect(cols.find((c) => c.key === "full_name")).toMatchObject({ label: "Your full name", type: "short_text" });
    // v1-only key keeps its v1 label — never a v2 label for a v1-only field.
    expect(cols.find((c) => c.key === "topic")).toMatchObject({ label: "Topic" });
  });

  it("is deterministic regardless of input order", () => {
    const a = deriveColumns([snap(1, v1), snap(2, v2)]);
    const b = deriveColumns([snap(2, v2), snap(1, v1)]);
    expect(a).toEqual(b);
  });

  it("never uses payload values as labels", () => {
    const cols = deriveColumns([snap(1, v1)]);
    for (const c of cols) {
      expect(c.label).not.toContain("Ann");
      expect(c.key).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("fieldIndex", () => {
  it("indexes pinned fields by stable key", () => {
    const idx = fieldIndex(v1);
    expect(idx.get("full_name")?.label).toBe("Full name");
    expect(idx.get("missing")).toBeUndefined();
  });
});

describe("renderTableCell", () => {
  const v1Idx = fieldIndex(v1);
  const v2Idx = fieldIndex(v2);

  it("interprets values through the pinned snapshot, not the header def", () => {
    // v1 row renders support label from v1 options even though v2 renamed things.
    const cell = renderTableCell(v1Idx.get("topic"), "support");
    expect(cell.text).toBe("Support");
    expect(cell.muted).toBe(false);
  });

  it("renders missing keys as empty, never reinterpreted", () => {
    // email_note exists only in v2: v1 rows show empty.
    expect(renderTableCell(v1Idx.get("email_note"), "anything")).toEqual({ text: "—", muted: true });
    // topic removed in v2: v2 rows show empty even with a stale payload value.
    expect(renderTableCell(v2Idx.get("topic"), "support")).toEqual({ text: "—", muted: true });
  });

  it("keeps option labels pinned per row version", () => {
    expect(renderTableCell(v1Idx.get("topic"), "sales").text).toBe("Sales");
    expect(renderTableCell(v1Idx.get("topic"), "zzz")).toEqual({ text: "zzz", muted: false });
  });
});

describe("formatCell", () => {
  it("truncates long text with a full-value title", () => {
    const long = "x".repeat(100);
    const out = formatCell({ kind: "text", text: long });
    expect(out.text).toBe(`${"x".repeat(48)}…`);
    expect(out.title).toBe(long);
    expect(out.muted).toBe(false);
  });

  it("preserves links and muted kinds", () => {
    expect(formatCell({ kind: "email", text: "a@b.test", href: "mailto:a@b.test" })).toEqual({
      text: "a@b.test",
      href: "mailto:a@b.test",
      muted: false,
    });
    expect(formatCell({ kind: "empty", text: "—" }).muted).toBe(true);
    expect(formatCell({ kind: "files", text: "No files" }).muted).toBe(true);
  });
});
