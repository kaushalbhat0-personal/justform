import { describe, expect, it } from "vitest";
import { isUuid, uuidv7 } from "./ids.js";

describe("uuidv7", () => {
  it("produces version-7 UUIDs", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(id[19]?.toLowerCase());
  });

  it("produces unique values", () => {
    expect(new Set([uuidv7(), uuidv7(), uuidv7()]).size).toBe(3);
  });
});
