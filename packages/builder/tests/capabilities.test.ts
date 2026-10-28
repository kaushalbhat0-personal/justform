import { describe, expect, it } from "vitest";
import { MVP_FIELD_TYPES } from "@formos/forms-engine";
import { FIELD_CAPABILITIES, PALETTE_ORDER, createDefaultField, type MvpFieldType } from "../src/capabilities.js";
import { addField, listFields } from "../src/document.js";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";

function emptyDoc(): CanonicalForm {
  return parseCanonicalForm({
    id: "11111111-1111-4111-8111-111111111111",
    key: "t",
    schemaVersion: 1,
    rendererVersion: "r",
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
            fields: [{ id: "44444444-4444-4444-8444-444444444444", key: "seed", type: "short_text", label: "Seed", required: false }],
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

describe("capabilities: palette derives from the canonical registry", () => {
  it("covers every MVP-12 type exactly once, in canonical order", () => {
    expect(PALETTE_ORDER).toEqual([...MVP_FIELD_TYPES]);
    expect(Object.keys(FIELD_CAPABILITIES).sort()).toEqual([...MVP_FIELD_TYPES].sort());
  });

  it("every palette type creates a minimal valid canonical field", () => {
    let doc = emptyDoc();
    const startCount = listFields(doc).length;
    for (const type of PALETTE_ORDER as MvpFieldType[]) {
      const added = addField(doc, type);
      doc = added.doc;
      expect(added.field.type).toBe(type);
    }
    expect(listFields(doc)).toHaveLength(startCount + PALETTE_ORDER.length);
    expect(() => parseCanonicalForm(doc)).not.toThrow();
  });

  it("choice types always ship usable defaults; file ships grant-safe defaults", () => {
    const dropdown = createDefaultField("dropdown", "id-1", "dd");
    if (dropdown.type !== "dropdown") throw new Error("wrong type");
    expect(dropdown.config.options.length).toBeGreaterThanOrEqual(2);
    const file = createDefaultField("file", "id-2", "f");
    if (file.type !== "file") throw new Error("wrong type");
    expect(file.validation.maxMB).toBeGreaterThan(0);
    expect(file.validation.mime.length).toBeGreaterThan(0);
  });
});
