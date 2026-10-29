import { describe, expect, it } from "vitest";
import { contactExample } from "@formos/forms-engine";
import { buildRendererArtifacts, fileFieldKeys, makeSubmissionGate } from "./submissionGate";
import { generatePublicId, PUBLIC_ID_RE } from "./publicIds";

describe("unguessable public identifiers", () => {
  it("are 128-bit URL-safe and unique", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generatePublicId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(PUBLIC_ID_RE);
      expect(id).toHaveLength(22);
    }
  });
});

describe("submission gate (client/server parity)", () => {
  const form = contactExample();

  it("accepts a valid submission and normalizes values", () => {
    const gate = makeSubmissionGate(form);
    const result = gate({ full_name: "Ada Lovelace", email: "ada@example.test", topic: "support" });
    expect(result.ok).toBe(true);
  });

  it("rejects missing/invalid fields with field-linked errors + error schema", () => {
    const gate = makeSubmissionGate(form);
    const result = gate({ full_name: "A", email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(Object.keys(result.errorSchema).length).toBeGreaterThan(0);
      expect(result.errors.every((e) => typeof e.key === "string" && typeof e.message === "string")).toBe(true);
    }
  });

  it("rejects browser-supplied unknown keys (strict shape)", () => {
    const gate = makeSubmissionGate(form);
    const result = gate({ full_name: "Ada Lovelace", email: "ada@example.test", topic: "support", workspace_id: "smuggled" });
    expect(result.ok).toBe(false);
  });

  it("derives renderer artifacts deterministically from the snapshot", () => {
    const a = buildRendererArtifacts(form);
    const b = buildRendererArtifacts(form);
    expect(a).toEqual(b);
    expect(a.jsonSchema.additionalProperties).toBe(false);
  });

  it("reports file field keys for the deferred-pipeline gate", () => {
    expect(fileFieldKeys(form)).toEqual(["attachments"]);
  });
});
