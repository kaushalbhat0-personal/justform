import { describe, expect, it } from "vitest";
import { contactExample } from "../src/examples.js";
import {
  CanonicalError,
  createPublishedSnapshot,
  hashCanonical,
  migrateToCurrent,
} from "../src/migrate.js";
import { parseCanonicalForm } from "../src/parse.js";

describe("versioning: current contract", () => {
  it("accepts schemaVersion 1 and pins the supported constant", () => {
    const form = parseCanonicalForm(contactExample());
    expect(form.schemaVersion).toBe(1);
  });

  it("rejects unsupported future versions safely (no guessing)", () => {
    const future = { ...JSON.parse(JSON.stringify(contactExample())), schemaVersion: 2 };
    expect(() => parseCanonicalForm(future)).toThrowError(CanonicalError);
    expect(() => parseCanonicalForm(future)).toThrowError(/newer than supported/);
    expect(() => migrateToCurrent(future)).toThrowError(/newer than supported/);
  });

  it("documents the migration architecture (forward-only registry)", () => {
    const { version } = migrateToCurrent(contactExample());
    expect(version).toBe(1);
  });
});

describe("versioning: published immutability", () => {
  it("mints deep-frozen snapshots with stable hashes", () => {
    const form = parseCanonicalForm(contactExample());
    const a = createPublishedSnapshot(form, 1);
    const b = createPublishedSnapshot(parseCanonicalForm(contactExample()), 1);
    expect(a.publishedVersion).toBe(1);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.schema)).toBe(true);
    expect(() => {
      (a.schema as { key: string }).key = "mutated";
    }).toThrow();
    expect(a.schema.key).toBe("contact_intake");
  });

  it("hashes are content-addressed (any change changes the hash)", () => {
    const one = parseCanonicalForm(contactExample());
    const two = parseCanonicalForm(contactExample());
    two.metadata.title = "Renamed";
    expect(hashCanonical(one)).not.toBe(hashCanonical(two));
  });

  it("rejects invalid published version numbers", () => {
    expect(() => createPublishedSnapshot(parseCanonicalForm(contactExample()), 0)).toThrowError(CanonicalError);
  });
});
