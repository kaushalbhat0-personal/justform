import { describe, expect, it } from "vitest";
import { contactExample } from "../src/examples.js";
import { generateJsonSchema } from "../src/jsonSchema.js";
import { stableStringify } from "../src/migrate.js";
import { parseCanonicalForm } from "../src/parse.js";
import { generateUiSchema } from "../src/uiSchema.js";

const form = () => parseCanonicalForm(contactExample());

/** Recursive lint: derived JSON Schema must avoid validator-dependent constructs. */
function assertSimpleSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assertSimpleSchema(item);
    return;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const banned of ["anyOf", "oneOf", "$ref", "if", "then", "else", "not", "allOf", "oneOf"]) {
      expect(record[banned], `banned JSON Schema construct: ${banned}`).toBeUndefined();
    }
    for (const value of Object.values(record)) assertSimpleSchema(value);
  }
}

describe("derivations: determinism", () => {
  it("generateJsonSchema/generateUiSchema are stable and equivalent across runs", () => {
    const a = form();
    const b = form();
    expect(stableStringify(generateJsonSchema(a))).toBe(stableStringify(generateJsonSchema(b)));
    expect(stableStringify(generateUiSchema(a))).toBe(stableStringify(generateUiSchema(b)));
  });

  it("typical snapshot stays well under the 64KB budget", () => {
    const bytes = Buffer.byteLength(stableStringify(form()), "utf8");
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

describe("derivations: JSON Schema", () => {
  it("uses only draft-07 simple constructs", () => {
    assertSimpleSchema(generateJsonSchema(form()));
  });

  it("maps requiredness, types, options, and constraints", () => {
    const schema = generateJsonSchema(form());
    expect(schema.required).toEqual(["full_name", "email", "topic"]);
    expect(schema.properties["full_name"]).toMatchObject({ type: "string", minLength: 2, maxLength: 80 });
    expect(schema.properties["email"]).toMatchObject({ type: "string", format: "email" });
    expect(schema.properties["age"]).toMatchObject({ type: "integer", minimum: 0, maximum: 130 });
    expect(schema.properties["topic"]).toMatchObject({ type: "string", enum: ["support", "sales"] });
    expect(schema.properties["contact_by"]).toMatchObject({ default: "email" });
    expect(schema.properties["interests"]).toMatchObject({
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: ["news", "beta", "events"] },
      maxItems: 2,
    });
    expect(schema.properties["visit_date"]).toMatchObject({ type: "string", format: "date" });
    expect(schema.properties["visit_time"]?.pattern).toContain("0-3");
    expect(schema.properties["attachments"]).toMatchObject({
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 3,
    });
    expect(schema.properties["campaign"]).toMatchObject({ type: "string" });
  });
});

describe("derivations: uiSchema", () => {
  it("maps expected widgets and preserves document order", () => {
    const ui = generateUiSchema(form());
    expect(ui["ui:order"]?.slice(0, 3)).toEqual(["full_name", "bio", "email"]);
    expect(ui["bio"]).toMatchObject({ "ui:widget": "textarea" });
    expect(ui["contact_by"]).toMatchObject({ "ui:widget": "radio" });
    expect(ui["interests"]).toMatchObject({ "ui:widget": "checkboxes" });
    expect(ui["attachments"]).toMatchObject({ "ui:widget": "formosFileRef" });
    expect(ui["campaign"]).toMatchObject({ "ui:widget": "hidden" });
    expect(ui["email"]).toMatchObject({ "ui:options": { autocomplete: "email" } });
  });
});

describe("S2: derivation performance", () => {
  it("derives a 200-field form 1000x with p99 under 25ms [S]", () => {
    const big = form();
    const section = big.pages[0]?.sections[0];
    if (!section) throw new Error("fixture missing section");
    const template = section.fields[0];
    if (!template) throw new Error("fixture missing field");
    const extra = [];
    for (let i = 0; i < 187; i += 1) {
      extra.push({ ...template, id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, key: `extra_${i}` });
    }
    section.fields.push(...(extra as typeof section.fields));
    const samples: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const start = performance.now();
      generateJsonSchema(big);
      generateUiSchema(big);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Number.POSITIVE_INFINITY;
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? Number.POSITIVE_INFINITY;
    // [S] spike measurement (no console: lint): p50/p99 surface in the
    // assertion message on failure.
    expect(p99, `derive p50=${p50.toFixed(3)}ms p99=${p99.toFixed(3)}ms over 1000 runs`).toBeLessThan(25);
  });
});
