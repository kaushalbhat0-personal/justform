import { describe, expect, it } from "vitest";
import { evaluateEntitlement, isBillingPlan, usagePercent } from "./billing.js";

describe("billing entitlement math", () => {
  it("allows under quota and reports remaining", () => {
    const v = evaluateEntitlement({ metric: "monthly_submissions", current: 41, limit: 100 });
    expect(v).toMatchObject({ allowed: true, current: 41, limit: 100, remaining: 59, reason: "ok" });
  });

  it("denies at and over quota with zero remaining", () => {
    expect(evaluateEntitlement({ metric: "active_forms", current: 5, limit: 5 }).allowed).toBe(false);
    const over = evaluateEntitlement({ metric: "active_forms", current: 7, limit: 5 });
    expect(over).toMatchObject({ allowed: false, remaining: 0, reason: "quota_exceeded" });
  });

  it("treats null limits as unlimited", () => {
    const v = evaluateEntitlement({ metric: "monthly_submissions", current: 999_999, limit: null });
    expect(v).toMatchObject({ allowed: true, limit: null, remaining: null });
  });

  it("treats null current as unmetered but allowed", () => {
    const v = evaluateEntitlement({ metric: "storage_bytes", current: null, limit: null });
    expect(v).toMatchObject({ allowed: true, reason: "unmetered" });
  });

  it("respects multi-unit quantities", () => {
    expect(evaluateEntitlement({ metric: "active_forms", current: 4, limit: 5, quantity: 1 }).allowed).toBe(true);
    expect(evaluateEntitlement({ metric: "active_forms", current: 4, limit: 5, quantity: 2 }).allowed).toBe(false);
  });
});

describe("usagePercent", () => {
  it("computes bounded percentages", () => {
    expect(usagePercent(41, 100)).toBeCloseTo(41);
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(0, 100)).toBe(0);
  });

  it("returns null for unbounded, unmetered, or zero limits", () => {
    expect(usagePercent(5, null)).toBeNull();
    expect(usagePercent(null, 100)).toBeNull();
    expect(usagePercent(5, 0)).toBeNull();
  });
});

describe("isBillingPlan", () => {
  it("accepts known plans only", () => {
    expect(isBillingPlan("free")).toBe(true);
    expect(isBillingPlan("enterprise")).toBe(false);
  });
});
