import { describe, expect, it } from "vitest";
import { contactExample } from "../src/examples.js";
import { parseCanonicalForm } from "../src/parse.js";
import {
  evaluateCondition,
  evaluateRule,
  resolveFieldState,
  validateRules,
} from "../src/rules.js";

const form = () => parseCanonicalForm(contactExample());

describe("rules: reference validation", () => {
  it("accepts the fixture rules (all refs resolve)", () => {
    expect(validateRules(form())).toEqual({ errors: [], cycleWarnings: [] });
  });

  it("rejects unknown field and page references (engine layer)", () => {
    const bad = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    bad.rules.push({
      id: "r-bad",
      when: "skip_page",
      if: { all: [{ field: "topic", op: "eq", value: "sales" }] },
      actions: [{ target: "nope", kind: "goto_page" }],
    });
    // Note: parseCanonicalForm itself rejects this first (defense in depth);
    // validateRules is the engine-side layer operating on trusted documents.
    expect(() => parseCanonicalForm(bad)).toThrowError(/unknown page key/);
    const { errors } = validateRules(bad);
    expect(errors.join(";")).toContain("unknown page key");
  });

  it("detects gating cycles as warnings (conservative strategy)", () => {
    const cyclic = JSON.parse(JSON.stringify(contactExample())) as ReturnType<typeof contactExample>;
    cyclic.rules.push(
      {
        id: "cycle-a",
        when: "show",
        if: { all: [{ field: "bio", op: "not_empty" }] },
        actions: [{ target: "email", kind: "show" }],
      },
      {
        id: "cycle-b",
        when: "show",
        if: { all: [{ field: "email", op: "not_empty" }] },
        actions: [{ target: "bio", kind: "show" }],
      },
    );
    const parsed = parseCanonicalForm(cyclic);
    const { errors, cycleWarnings } = validateRules(parsed);
    expect(errors).toEqual([]);
    expect(cycleWarnings.length).toBeGreaterThan(0);
    expect(cycleWarnings[0]).toContain("bio");
  });
});

describe("rules: pure evaluation (no eval, no code)", () => {
  it("evaluates operators over normalized values", () => {
    expect(evaluateCondition({ field: "topic", op: "eq", value: "sales" }, { topic: "sales" })).toBe(true);
    expect(evaluateCondition({ field: "age", op: "gte", value: 18 }, { age: 36 })).toBe(true);
    expect(evaluateCondition({ field: "interests", op: "contains", value: "beta" }, { interests: ["beta"] })).toBe(true);
    expect(evaluateCondition({ field: "bio", op: "empty" }, { bio: "" })).toBe(true);
    expect(evaluateCondition({ field: "topic", op: "in", value: ["a", "sales"] }, { topic: "sales" })).toBe(true);
  });

  it("resolves show/hide and require/optional field state", () => {
    const sales = resolveFieldState(form(), { topic: "sales" });
    expect(sales.get("company_size")?.visible).toBe(true);
    const support = resolveFieldState(form(), { topic: "support" });
    expect(support.get("company_size")?.visible).toBe(false);
    const withDate = resolveFieldState(form(), { topic: "support", visit_date: "2099-01-01" });
    expect(withDate.get("visit_time")?.required).toBe(true);
    const withoutDate = resolveFieldState(form(), { topic: "support" });
    expect(withoutDate.get("visit_time")?.required).toBe(false);
    expect(withoutDate.get("email")?.required).toBe(true);
  });

  it("evaluates whole rules against value maps", () => {
    const rule = form().rules[0];
    if (!rule) throw new Error("fixture missing rule");
    expect(evaluateRule(rule, { topic: "sales" })).toBe(true);
    expect(evaluateRule(rule, { topic: "support" })).toBe(false);
  });
});
