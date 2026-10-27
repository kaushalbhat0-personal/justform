import { describe, expect, it } from "vitest";
import { toRjsfErrorSchema, zodIssuesToErrorSchema } from "../src/errors.js";
import { contactExample } from "../src/examples.js";
import { indexFieldsByKey, parseCanonicalForm } from "../src/parse.js";
import { validateSubmission } from "../src/zod.js";

const form = () => parseCanonicalForm(contactExample());

describe("error mapping: stable field identities", () => {
  it("maps issues to canonical field ids, keys, and stable codes", () => {
    const result = validateSubmission(form(), { full_name: "A", topic: "gossip" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byId = new Map(result.errors.map((e) => [e.key, e]));
    expect(byId.get("full_name")?.code).toBe("min_length");
    expect(byId.get("topic")?.code).toBe("not_in_enum");
    expect(byId.get("email")?.code).toBe("required");
    for (const error of result.errors) {
      expect(error.source).toBe("zod");
      if (error.key !== "") {
        const field = form().pages[0]?.sections[0]?.fields.find((f) => f.key === error.key);
        expect(error.fieldId).toBe(field?.id ?? "");
      }
    }
  });

  it("maps nested array paths (checkbox item index)", () => {
    const result = validateSubmission(form(), {
      full_name: "Ada Lovelace",
      email: "ada@example.test",
      topic: "support",
      interests: ["news", "bogus"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const item = result.errors.find((e) => e.path.length === 2);
    expect(item?.key).toBe("interests");
    expect(item?.path).toEqual(["interests", 1]);
    expect(item?.fieldId).toBe(
      form().pages[0]?.sections[0]?.fields.find((f) => f.key === "interests")?.id ?? "",
    );
  });

  it("folds errors into an RJSF ErrorSchema for extraErrors", () => {
    const result = validateSubmission(form(), { full_name: "A", topic: "support" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const byKey = indexFieldsByKey(form());
    const { errors, errorSchema } = zodIssuesToErrorSchema(
      result.errors.map((e) => ({ code: "custom" as const, path: e.path, message: e.message })),
      byKey,
    );
    expect(errors).toHaveLength(result.errors.length);
    const emailNode = errorSchema["email"];
    const emailErrors = typeof emailNode === "object" && emailNode !== null && !Array.isArray(emailNode) ? emailNode.__errors : [];
    expect(emailErrors?.length).toBeGreaterThan(0);
    const nested = toRjsfErrorSchema([
      { fieldId: "x", key: "interests", path: ["interests", 1], code: "not_in_enum", message: "bad", source: "zod" },
    ]);
    const interestsNode = nested["interests"];
    const itemNode =
      typeof interestsNode === "object" && interestsNode !== null && !Array.isArray(interestsNode)
        ? interestsNode["1"]
        : undefined;
    const itemErrors =
      typeof itemNode === "object" && itemNode !== null && !Array.isArray(itemNode) ? itemNode.__errors : [];
    expect(itemErrors).toEqual(["bad"]);
  });

  it("never leaks library error objects (plain data only)", () => {
    const result = validateSubmission(form(), { topic: "support" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const error of result.errors) {
      expect(Object.getPrototypeOf(error)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(error))).toEqual({ ...error });
    }
  });
});
