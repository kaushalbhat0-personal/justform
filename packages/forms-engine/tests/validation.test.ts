import { describe, expect, it } from "vitest";
import { contactExample } from "../src/examples.js";
import { parseCanonicalForm } from "../src/parse.js";
import { generateZod, validateSubmission } from "../src/zod.js";
import { stableStringify } from "../src/migrate.js";

const form = () => parseCanonicalForm(contactExample());

const VALID = {
  full_name: "Ada Lovelace",
  bio: "Pioneer.",
  email: "ada@example.test",
  age: 36,
  phone: "+61 412 345 678",
  topic: "sales",
  contact_by: "email",
  interests: ["news", "beta"],
  visit_date: "2099-01-15",
  visit_time: "10:30",
  attachments: ["123e4567-e89b-42d3-a456-426614174000"],
  campaign: "spring",
  company_size: 50,
  priority: 10,
};

describe("Zod derivation: valid values accepted + normalized", () => {
  it("accepts a fully valid submission and normalizes it", () => {
    const result = validateSubmission(form(), VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values["phone"]).toBe("+61412345678");
    expect(result.values["email"]).toBe("ada@example.test");
  });

  it("fills canonical defaults and collapses untouched optionals", () => {
    const result = validateSubmission(form(), {
      full_name: "Al",
      email: "al@example.test",
      topic: "support",
      bio: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values["contact_by"]).toBe("email");
    expect(result.values["bio"]).toBeUndefined();
  });

  it("client and server runs agree structurally (single generator parity)", () => {
    const client = validateSubmission(form(), VALID);
    const server = validateSubmission(parseCanonicalForm(JSON.parse(JSON.stringify(contactExample()))), VALID);
    expect(client.ok).toBe(true);
    expect(server.ok).toBe(true);
    if (client.ok && server.ok) {
      expect(stableStringify(client.values)).toBe(stableStringify(server.values));
    }
  });
});

describe("Zod derivation: invalid values rejected", () => {
  it("rejects missing required fields", () => {
    const result = validateSubmission(form(), { full_name: "Al", topic: "support" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.key === "email" && e.code === "required")).toBe(true);
  });

  it("rejects constraint violations per field", () => {
    const cases: Array<{ key: string; value: unknown }> = [
      { key: "email", value: "not-an-email" },
      { key: "age", value: 36.5 },
      { key: "age", value: 200 },
      { key: "phone", value: "123" },
      { key: "topic", value: "gossip" },
      { key: "interests", value: ["news", "beta", "events"] },
      { key: "visit_date", value: "2024-02-30" },
      { key: "visit_time", value: "25:00" },
      { key: "attachments", value: ["not-a-uuid"] },
    ];
    for (const { key, value } of cases) {
      const attempt = validateSubmission(form(), { ...VALID, [key]: value });
      expect(attempt.ok, `expected rejection for ${key}=${JSON.stringify(value)}`).toBe(false);
    }
  });

  it("rejects unknown keys (strict object)", () => {
    const result = validateSubmission(form(), { ...VALID, hacker: true });
    expect(result.ok).toBe(false);
  });
});

describe("Zod derivation: determinism", () => {
  it("generates equivalent schemas across runs", () => {
    const a = generateZod(form());
    const b = generateZod(form());
    const good = a.safeParse(VALID);
    expect(good.success).toBe(true);
    expect(b.safeParse(VALID).success).toBe(true);
    expect(Object.keys(a.shape).join(",")).toBe(Object.keys(b.shape).join(","));
  });
});
