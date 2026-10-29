import { describe, expect, it } from "vitest";
import { DomainError } from "@formos/domain";
import { ApiError, apiErrorResponse, apiOk, parseLimitParam } from "./envelope";

describe("API envelope", () => {
  it("wraps data with request id and pagination", async () => {
    const res = apiOk("req-1", [{ id: 1 }], { page: { next_cursor: "abc", has_more: true }, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    const body = await res.json();
    expect(body).toEqual({ data: [{ id: 1 }], page: { next_cursor: "abc", has_more: true } });
  });

  it("omits pagination when absent", async () => {
    const res = apiOk("req-1", { a: 1 });
    expect(await res.json()).toEqual({ data: { a: 1 } });
  });

  it("maps ApiError to stable envelopes without internals", async () => {
    const res = apiErrorResponse(new ApiError("NOT_FOUND", "Missing.", 404), "req-2");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Missing.", request_id: "req-2" } });
  });

  it("collapses unknown errors to generic 500s", async () => {
    const res = apiErrorResponse(new Error("column foo does not exist"), "req-3");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("column");
  });

  it("maps DomainError cursor/shape failures to stable codes, not 500s", async () => {
    const notFound = apiErrorResponse(new DomainError({ code: "not_found", message: "Submission not found." }), "req-5");
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Submission not found.", request_id: "req-5" },
    });
    const forbidden = apiErrorResponse(new DomainError({ code: "forbidden", message: "Nope." }), "req-6");
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("FORBIDDEN");
    const internal = apiErrorResponse(new DomainError({ code: "internal", message: "Boom." }), "req-7");
    expect(internal.status).toBe(500);
    expect((await internal.json()).error.code).toBe("INTERNAL");
  });

  it("sets Retry-After on rate-limited errors", () => {
    const res = apiErrorResponse(new ApiError("RATE_LIMITED", "Slow down.", 429, 17), "req-4");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
  });
});

describe("parseLimitParam", () => {
  it("applies defaults and clamps", () => {
    expect(parseLimitParam(null, 20, 100)).toBe(20);
    expect(parseLimitParam("", 20, 100)).toBe(20);
    expect(parseLimitParam("25", 20, 100)).toBe(25);
    expect(parseLimitParam("500", 20, 100)).toBe(100);
  });

  it("rejects non-positive integers", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "NaN"]) {
      try {
        parseLimitParam(bad, 20, 100);
        expect.unreachable(`accepted ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe("VALIDATION_FAILED");
      }
    }
  });
});
