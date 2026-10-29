import { describe, expect, it } from "vitest";
import { contactExample } from "@formos/forms-engine";
import {
  formatTimestamp,
  iterFields,
  renderValue,
  summarizeSubmission,
  textSearchKeys,
} from "./present";

const form = contactExample();
const byKey = (key: string) => {
  const field = iterFields(form).find((f) => f.key === key);
  if (!field) throw new Error(`fixture field missing: ${key}`);
  return field;
};

describe("submission value rendering", () => {
  it("renders text plainly and empty values as an em dash", () => {
    expect(renderValue(byKey("full_name"), "Ada")).toEqual({ kind: "text", text: "Ada" });
    expect(renderValue(byKey("full_name"), "")).toEqual({ kind: "empty", text: "—" });
    expect(renderValue(byKey("full_name"), null)).toEqual({ kind: "empty", text: "—" });
    expect(renderValue(byKey("bio"), undefined)).toEqual({ kind: "empty", text: "—" });
  });

  it("linkifies only validated emails and phones (never raw hrefs)", () => {
    expect(renderValue(byKey("email"), "ada@example.test")).toEqual({
      kind: "email",
      text: "ada@example.test",
      href: "mailto:ada@example.test",
    });
    expect(renderValue(byKey("email"), "not-an-email")).toEqual({ kind: "text", text: "not-an-email" });
    expect(renderValue(byKey("phone"), "+61412345678")).toEqual({
      kind: "phone",
      text: "+61412345678",
      href: "tel:+61412345678",
    });
    expect(renderValue(byKey("phone"), "javascript:alert(1)")).toEqual({ kind: "text", text: "javascript:alert(1)" });
  });

  it("formats calendar dates without timezone shifts", () => {
    const rendered = renderValue(byKey("visit_date"), "2026-10-29");
    expect(rendered.kind).toBe("date");
    expect(rendered.text).toContain("2026-10-29");
    expect(renderValue(byKey("visit_date"), "tomorrow").kind).toBe("text");
  });

  it("resolves option labels from the pinned snapshot, flagging unknowns", () => {
    expect(renderValue(byKey("topic"), "support")).toEqual({ kind: "options", text: "Support", labels: ["Support"] });
    expect(renderValue(byKey("topic"), "smuggled")).toEqual({ kind: "unknown", text: "smuggled", raw: "smuggled" });
    expect(renderValue(byKey("interests"), ["news", "beta"])).toEqual({
      kind: "options",
      text: "Newsletter, Beta program",
      labels: ["Newsletter", "Beta program"],
    });
    expect(renderValue(byKey("interests"), ["news", "zzz"])).toMatchObject({ kind: "options", text: "Newsletter, zzz" });
    expect(renderValue(byKey("interests"), [])).toEqual({ kind: "empty", text: "—" });
  });

  it("renders file references as safe placeholders, never URLs", () => {
    expect(renderValue(byKey("attachments"), [])).toEqual({ kind: "files", text: "No files" });
    const rendered = renderValue(byKey("attachments"), ["a", "b"]);
    expect(rendered.kind).toBe("files");
    expect(rendered.text).toContain("unavailable");
    expect(JSON.stringify(rendered)).not.toMatch(/https?:|bucket|storage/i);
  });

  it("never trusts payload HTML (plain-text pass-through)", () => {
    const rendered = renderValue(byKey("full_name"), "<img src=x onerror=alert(1)>");
    expect(rendered).toEqual({ kind: "text", text: "<img src=x onerror=alert(1)>" });
  });
});

describe("field order and summaries", () => {
  it("iterates fields in canonical document order", () => {
    expect(iterFields(form).map((f) => f.key)).toEqual([
      "full_name",
      "bio",
      "email",
      "age",
      "phone",
      "topic",
      "contact_by",
      "interests",
      "visit_date",
      "visit_time",
      "attachments",
      "campaign",
      "company_size",
      "priority",
    ]);
  });

  it("derives summaries from document order without hardcoded names", () => {
    expect(summarizeSubmission(form, { full_name: "Ada Lovelace", email: "ada@example.test" })).toEqual({
      primary: "Ada Lovelace",
      secondary: "ada@example.test",
    });
    expect(summarizeSubmission(form, { topic: "sales" })).toEqual({ primary: "Sales", secondary: null });
    expect(summarizeSubmission(form, {})).toEqual({ primary: "Submission", secondary: null });
    // Unknown keys never leak into summaries.
    expect(summarizeSubmission(form, { workspace_id: "smuggled" } as never)).toEqual({
      primary: "Submission",
      secondary: null,
    });
  });

  it("exposes text-like keys for server-backed search", () => {
    expect(textSearchKeys(form)).toEqual(["full_name", "bio", "email", "phone"]);
  });

  it("formats timestamps deterministically in UTC", () => {
    expect(formatTimestamp("2026-10-29T10:00:00.000Z")).toContain("2026");
    expect(formatTimestamp("garbage")).toBe("garbage");
  });
});
