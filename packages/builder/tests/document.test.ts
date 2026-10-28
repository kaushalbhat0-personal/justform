import { describe, expect, it } from "vitest";
import {
  addField,
  deleteField,
  listFields,
  moveField,
  moveFieldTo,
  newFieldId,
  uniqueKey,
  updateField,
  validateDocument,
} from "../src/document.js";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";

function baseDoc(): CanonicalForm {
  return parseCanonicalForm({
    id: "11111111-1111-4111-8111-111111111111",
    key: "t",
    schemaVersion: 1,
    rendererVersion: "rjsf-6.11+drv1",
    metadata: { title: "T" },
    settings: {},
    pages: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        key: "main",
        sections: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            key: "s",
            fields: [{ id: "44444444-4444-4444-8444-444444444444", key: "name", type: "short_text", label: "Name", required: true }],
          },
        ],
      },
    ],
    rules: [],
    calculations: [],
    localization: {},
    notificationsRef: null,
    integrationsRef: null,
  });
}

describe("document ops: add field", () => {
  it("creates minimal valid fields with fresh ids and unique keys", () => {
    const { doc, field } = addField(baseDoc(), "email");
    expect(field.type).toBe("email");
    expect(field.id).not.toBe("44444444-4444-4444-8444-444444444444");
    expect(listFields(doc)).toHaveLength(2);
    const again = addField(doc, "short_text", {}, { label: "Name" });
    expect(again.field.key).not.toBe("name");
    expect(again.field.key).toMatch(/^name/);
  });

  it("creates valid choice fields with default options", () => {
    const { doc, field } = addField(baseDoc(), "dropdown");
    expect(field.type).toBe("dropdown");
    if (field.type === "dropdown") expect(field.config.options.length).toBeGreaterThanOrEqual(2);
    expect(() => parseCanonicalForm(doc)).not.toThrow();
  });

  it("never reuses ids (uuid v4 shape, unique across adds)", () => {
    const ids = new Set<string>();
    let doc = baseDoc();
    for (let i = 0; i < 5; i += 1) {
      const added = addField(doc, "short_text");
      doc = added.doc;
      expect(added.field.id).toMatch(/^[0-9a-f-]{36}$/);
      ids.add(added.field.id);
    }
    expect(ids.size).toBe(5);
    expect(newFieldId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uniqueKey suffixes on collision", () => {
    expect(uniqueKey(baseDoc(), "Name")).toBe("name_2");
    expect(uniqueKey(baseDoc(), "Fresh")).toBe("fresh");
  });
});

describe("document ops: edit properties", () => {
  it("edits label/required/placeholder within canonical bounds", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const { doc } = updateField(baseDoc(), id, { label: "Full name", required: true, placeholder: "Ada" });
    const field = listFields(doc).find((f) => f.id === id);
    expect(field?.label).toBe("Full name");
    expect(field?.required).toBe(true);
    expect(field?.presentation?.placeholder).toBe("Ada");
  });

  it("rejects options on non-choice types and bad option payloads", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(() => updateField(baseDoc(), id, { options: [{ value: "a", label: "A" }] })).toThrow(/not supported/);
    const { doc } = addField(baseDoc(), "dropdown");
    const added = listFields(doc).find((f) => f.type === "dropdown");
    if (!added) throw new Error("missing");
    expect(() => updateField(doc, added.id, { options: [{ value: "a", label: "" }] })).toThrow(/labels are required/);
    expect(() => updateField(doc, added.id, { options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })).toThrow(/unique/);
  });

  it("rejects unknown constraint keys and type-mismatched defaults", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    expect(() => updateField(baseDoc(), id, { validation: { mime: ["x"] } })).toThrow(/not editable/);
    expect(() => updateField(baseDoc(), id, { default: 42 })).toThrow(/type mismatch/);
  });

  it("result always re-validates as canonical", () => {
    const { doc } = updateField(baseDoc(), "44444444-4444-4444-8444-444444444444", { validation: { minLength: 2, maxLength: 5 } });
    expect(() => parseCanonicalForm(doc)).not.toThrow();
  });
});

describe("document ops: reorder", () => {
  it("moves fields up/down deterministically with stable ids", () => {
    let doc = baseDoc();
    const a = addField(doc, "short_text", {}, { label: "A" });
    doc = a.doc;
    const b = addField(doc, "short_text", {}, { label: "B" });
    doc = b.doc;
    const order = () => listFields(doc).map((f) => f.id);
    const before = order();
    const moved = moveField(doc, b.field.id, "up");
    expect(moved.moved).toBe(true);
    doc = moved.doc;
    expect(order()).toEqual([before[0], before[2], before[1]]);
    expect(listFields(doc).map((f) => f.key)).toContain("name");
    const edge = moveField(doc, before[0] as string, "up");
    expect(edge.moved).toBe(false);
  });

  it("moves across sections without regenerating ids", () => {
    let doc = baseDoc();
    const added = addField(doc, "short_text", {}, { label: "X" });
    doc = added.doc;
    const next = moveFieldTo(added.doc, added.field.id, { pageKey: "main", sectionKey: "s", index: 0 });
    const fields = listFields(next.doc);
    expect(fields[0]?.id).toBe(added.field.id);
    expect(fields.map((f) => f.key)).toContain("x");
  });
});

describe("document ops: delete", () => {
  it("deletes unreferenced fields and tombstones the id", () => {
    const { doc } = addField(baseDoc(), "short_text", {}, { label: "Gone" });
    const target = listFields(doc).find((f) => f.key === "gone");
    if (!target) throw new Error("missing");
    const result = deleteField(doc, target.id);
    if (!result.ok) throw new Error("unexpected blockers");
    expect(listFields(result.doc).some((f) => f.id === target.id)).toBe(false);
    expect(result.doc.deletedIds).toContain(target.id);
  });

  it("blocks deletion of rule/calculation-referenced keys (never silently corrupts)", () => {
    let doc = baseDoc();
    const topic = addField(doc, "dropdown", {}, { label: "Topic" });
    doc = topic.doc;
    const withRule: CanonicalForm = {
      ...doc,
      rules: [
        {
          id: "r1",
          when: "show",
          if: { all: [{ field: "name", op: "eq", value: "x" }] },
          actions: [{ target: topic.field.key, kind: "show" }],
        },
      ],
    };
    const result = deleteField(withRule, topic.field.id);
    if (result.ok) throw new Error("expected blockers");
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(listFields(withRule).some((f) => f.id === topic.field.id)).toBe(true);
  });
});

describe("document ops: validateDocument", () => {
  it("accepts canonical docs and maps failures to field ids where possible", () => {
    expect(validateDocument(baseDoc()).ok).toBe(true);
    const broken = JSON.parse(JSON.stringify(baseDoc())) as CanonicalForm;
    const fields = broken.pages[0]?.sections[0]?.fields;
    if (!fields || !fields[0]) throw new Error("missing");
    (fields[0] as unknown as Record<string, unknown>)["type"] = "matrix";
    const result = validateDocument(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.fieldId).toBe("44444444-4444-4444-8444-444444444444");
  });
});
