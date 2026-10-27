import { describe, expect, it } from "vitest";
import { contactExample } from "../src/examples.js";
import { CanonicalError } from "../src/migrate.js";
import { parseCanonicalForm } from "../src/parse.js";

const uuid = (n: number): string => {
  const h = n.toString(16).padStart(2, "0");
  return `20000000-0000-4000-8000-0000000000${h}`;
};

/** Array access with a loud failure instead of a non-null assertion. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test fixture missing ${what}`);
  return value;
}

describe("canonical schema: valid forms", () => {
  it("accepts the S1 example fixture", () => {
    const form = parseCanonicalForm(contactExample());
    expect(form.schemaVersion).toBe(1);
    expect(form.key).toBe("contact_intake");
  });

  it("accepts a minimal single-field form", () => {
    const form = parseCanonicalForm({
      id: uuid(1),
      key: "mini",
      schemaVersion: 1,
      rendererVersion: "rjsf-6.11+drv1",
      metadata: { title: "Mini" },
      settings: {},
      pages: [
        {
          id: uuid(2),
          key: "main",
          sections: [
            {
              id: uuid(3),
              key: "s",
              fields: [{ id: uuid(4), key: "name", type: "short_text", label: "Name", required: true }],
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
    expect(form.pages[0]?.sections[0]?.fields).toHaveLength(1);
  });

  it("accepts x- extension types opaquely", () => {
    const base = contactExample() as unknown as Record<string, unknown>;
    const pages = base["pages"] as Array<Record<string, unknown>>;
    const sections = pages[0]?.["sections"] as Array<Record<string, unknown>>;
    (sections[0]?.["fields"] as unknown[]).push({
      id: uuid(9),
      key: "nps",
      type: "x-nps",
      label: "Score",
      required: false,
      config: { max: 10 },
    });
    const form = parseCanonicalForm(base);
    expect(form.pages[0]?.sections[0]?.fields.some((f) => f.key === "nps")).toBe(true);
  });
});

describe("canonical schema: invalid forms", () => {
  it("rejects unknown non-x field types", () => {
    const base = JSON.parse(JSON.stringify(contactExample())) as Record<string, unknown>;
    const pages = base["pages"] as unknown[];
    const sections = (must(pages[0], "page") as Record<string, unknown>)["sections"] as unknown[];
    const fields = must(sections[0], "section") as Record<string, unknown>;
    const list = fields["fields"] as Array<Record<string, unknown>>;
    must(list[0], "field")["type"] = "matrix";
    expect(() => parseCanonicalForm(base)).toThrowError(CanonicalError);
    expect(() => parseCanonicalForm(base)).toThrowError(/unknown field type/);
  });

  it("rejects duplicate field ids and keys", () => {
    const dupId = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    const dupIdFields = must(must(must(dupId.pages[0], "page").sections[0], "section").fields, "fields");
    must(dupIdFields[1], "field").id = must(dupIdFields[0], "field").id;
    expect(() => parseCanonicalForm(dupId)).toThrowError(/duplicate field id/);
    const dupKey = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    const dupKeyFields = must(must(must(dupKey.pages[0], "page").sections[0], "section").fields, "fields");
    must(dupKeyFields[1], "field").key = must(dupKeyFields[0], "field").key;
    expect(() => parseCanonicalForm(dupKey)).toThrowError(/duplicate field key/);
  });

  it("rejects invalid field configuration (wrong value kinds, empty options)", () => {
    const bad = JSON.parse(JSON.stringify(contactExample())) as Record<string, unknown>;
    const badPages = bad["pages"] as unknown[];
    const badSections = (must(badPages[0], "page") as Record<string, unknown>)["sections"] as unknown[];
    const badFields = (must(badSections[0], "section") as Record<string, unknown>)["fields"] as Record<
      string,
      unknown
    >[];
    must(badFields[0], "field")["validation"] = { minLength: "two" };
    expect(() => parseCanonicalForm(bad)).toThrowError(CanonicalError);
    const badOptions = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    const badOptionsFields = must(must(must(badOptions.pages[0], "page").sections[0], "section").fields, "fields");
    const topic = badOptionsFields.find((f) => f.key === "topic");
    if (topic?.type === "dropdown") topic.config.options = [];
    expect(() => parseCanonicalForm(badOptions)).toThrowError(CanonicalError);
  });

  it("rejects inconsistent ranges and contradictory requiredness", () => {
    const bad = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    const badFields = must(must(must(bad.pages[0], "page").sections[0], "section").fields, "fields");
    const name = badFields.find((f) => f.key === "full_name");
    if (name?.type === "short_text") name.validation = { minLength: 10, maxLength: 5 };
    expect(() => parseCanonicalForm(bad)).toThrowError(/minLength exceeds maxLength/);
  });

  it("rejects dangling rule and calculation references", () => {
    const bad = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    bad.rules.push({
      id: "bad-rule",
      when: "show",
      if: { all: [{ field: "ghost", op: "eq", value: 1 }] },
      actions: [{ target: "email", kind: "show" }],
    });
    expect(() => parseCanonicalForm(bad)).toThrowError(/unknown field key/);
    const badCalc = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    badCalc.calculations.push({
      id: "bad-calc",
      target: "priority",
      expression: { kind: "ref", field: "ghost" },
      deps: ["ghost"],
    });
    expect(() => parseCanonicalForm(badCalc)).toThrowError(/unknown field key/);
  });

  it("rejects non-objects and missing schemaVersion", () => {
    expect(() => parseCanonicalForm(null)).toThrowError(/must be an object/);
    expect(() => parseCanonicalForm({ key: "x" })).toThrowError(/schemaVersion/);
  });
});
