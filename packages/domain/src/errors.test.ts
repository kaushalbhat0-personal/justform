import { describe, expect, it } from "vitest";
import {
  DomainError,
  HTTP_STATUS,
  toDomainError,
} from "./errors.js";

describe("DomainError", () => {
  it("maps codes to HTTP status", () => {
    expect(HTTP_STATUS["not_found"]).toBe(404);
    expect(HTTP_STATUS["plan_limit"]).toBe(402);
    expect(HTTP_STATUS["rate_limited"]).toBe(429);
  });

  it("serializes to a safe public envelope", () => {
    const err = new DomainError({
      code: "forbidden",
      message: "Denied.",
      details: { resource: "form" },
      requestId: "req_1",
      cause: { secret: "must-not-leak" },
    });
    const envelope = err.toEnvelope();
    expect(envelope).toEqual({
      error: {
        code: "forbidden",
        message: "Denied.",
        details: { resource: "form" },
        request_id: "req_1",
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("must-not-leak");
  });

  it("defaults request id when absent", () => {
    const envelope = new DomainError({ code: "internal", message: "x" }).toEnvelope();
    expect(envelope.error.request_id).toBe("req_unknown");
  });

  it("passes DomainError through and wraps unknowns safely", () => {
    const original = new DomainError({ code: "gone", message: "Closed." });
    expect(toDomainError(original)).toBe(original);
    const wrapped = toDomainError(new Error("db connection string leak"), "req_9");
    expect(wrapped.code).toBe("internal");
    expect(wrapped.toEnvelope().error.message).not.toContain("db connection");
    expect(wrapped.toEnvelope().error.request_id).toBe("req_9");
  });
});
