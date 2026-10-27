import { describe, expect, it, vi } from "vitest";
import { logger, redact } from "./logging.js";

describe("redact", () => {
  it("redacts sensitive keys case-insensitively and nested", () => {
    const out = redact({
      user: "a",
      password: "p",
      nested: { API_KEY: "k", ok: 1 },
      arr: [{ token: "t" }],
    });
    expect(out).toEqual({
      user: "a",
      password: "[redacted]",
      nested: { API_KEY: "[redacted]", ok: 1 },
      arr: [{ token: "[redacted]" }],
    });
  });

  it("never mutates the input", () => {
    const input = { secret: "s" };
    redact(input);
    expect(input.secret).toBe("s");
  });
});

describe("logger", () => {
  it("emits JSON lines without secrets", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    logger.error("boom", { requestId: "r1" }, { secret: "x", count: 2 });
    const line = String(err.mock.calls[0]?.[0] ?? "");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["msg"]).toBe("boom");
    expect(parsed["secret"]).toBe("[redacted]");
    expect(parsed["count"]).toBe(2);
    err.mockRestore();
  });
});
