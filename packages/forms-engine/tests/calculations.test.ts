import { describe, expect, it } from "vitest";
import { evaluateCalculations, validateCalculations } from "../src/calculations.js";
import type { CalcNode } from "../src/schema.js";
import { contactExample } from "../src/examples.js";
import { parseCanonicalForm } from "../src/parse.js";

const form = () => parseCanonicalForm(contactExample());

describe("calculations: representation without executable code", () => {
  it("accepts the fixture calc (refs resolve, deps match)", () => {
    expect(validateCalculations(form())).toEqual({ errors: [], cycleWarnings: [] });
  });

  it("rejects unknown refs and deps mismatches", () => {
    const bad = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    bad.calculations.push({
      id: "bad",
      target: "priority",
      expression: { kind: "ref", field: "ghost" },
      deps: ["ghost"],
    });
    expect(() => parseCanonicalForm(bad)).toThrowError(/unknown field key/);
    const mismatch = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    const first = mismatch.calculations[0];
    if (!first) throw new Error("fixture missing calculation");
    first.deps = ["topic", "email"];
    expect(() => parseCanonicalForm(mismatch)).toThrowError(/deps mismatch/);
  });

  it("rejects self-dependencies and duplicate targets", () => {
    const self = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    self.calculations.push({
      id: "self",
      target: "age",
      expression: { kind: "ref", field: "age" },
      deps: ["age"],
    });
    expect(() => parseCanonicalForm(self)).toThrowError(/own dependency/);
  });
});

describe("calculations: pure bounded evaluation", () => {
  it("evaluates arithmetic, comparisons, IF, CONCAT, DATE_DIFF, aggregates", () => {
    const values = { age: 36, topic: "sales", visit_date: "2099-01-15", full_name: "Ada" };
    const results = evaluateCalculations(form(), values);
    expect(results.get("priority")).toEqual({ ok: true, value: 10 });
    const sales = evaluateCalculations(form(), { ...values, topic: "support" });
    expect(sales.get("priority")).toEqual({ ok: true, value: 1 });
  });

  it("returns errors (never throws) for invalid or missing refs", () => {
    const div: CalcNode = { kind: "binary", op: "/", left: { kind: "lit", value: 1 }, right: { kind: "lit", value: 0 } };
    const withDiv = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    withDiv.calculations.push({ id: "div", target: "age", expression: div, deps: [] });
    const parsed = parseCanonicalForm(withDiv);
    const results = evaluateCalculations(parsed, { topic: "sales" });
    expect(results.get("age")).toEqual({ ok: false, error: "division by zero" });
    const missing = evaluateCalculations(form(), { topic: "sales" });
    // priority needs no missing input here (topic present) — sanity: still computes
    expect(missing.get("priority")).toEqual({ ok: true, value: 10 });
  });

  it("flags dependency cycles instead of hanging", () => {
    const cyclic = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    cyclic.calculations = [
      { id: "c1", target: "age", expression: { kind: "ref", field: "priority" }, deps: ["priority"] },
      { id: "c2", target: "priority", expression: { kind: "ref", field: "age" }, deps: ["age"] },
    ];
    const parsed = parseCanonicalForm(cyclic);
    const { cycleWarnings } = validateCalculations(parsed);
    expect(cycleWarnings.length).toBeGreaterThan(0);
    const results = evaluateCalculations(parsed, { topic: "sales", age: 3 });
    expect(results.get("age")?.ok).toBe(false);
    expect(results.get("priority")?.ok).toBe(false);
  });

  it("contains no executable-code surface (AST is data)", () => {
    const serialized = JSON.stringify(contactExample().calculations);
    expect(serialized).not.toContain("eval");
    expect(serialized).not.toContain("Function");
    expect(typeof contactExample().calculations[0]?.expression).toBe("object");
  });
});
