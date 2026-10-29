import { describe, expect, it } from "vitest";
import { classifyOutcome, isExhausted, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS, retryDelaySeconds } from "./retry";

describe("delivery classification", () => {
  it("delivers on 2xx", () => {
    expect(classifyOutcome({ ok: true, status: 200, redirected: false, responseMs: 10 })).toMatchObject({ kind: "delivered", statusCode: 200 });
    expect(classifyOutcome({ ok: true, status: 201, redirected: false, responseMs: 10 }).kind).toBe("delivered");
    expect(classifyOutcome({ ok: true, status: 204, redirected: false, responseMs: 10 }).kind).toBe("delivered");
  });

  it("retries 429, 5xx, timeouts and network failures", () => {
    expect(classifyOutcome({ ok: false, status: 429, redirected: false, responseMs: 10 }).kind).toBe("retryable");
    expect(classifyOutcome({ ok: false, status: 500, redirected: false, responseMs: 10 }).kind).toBe("retryable");
    expect(classifyOutcome({ ok: false, status: 503, redirected: false, responseMs: 10 }).kind).toBe("retryable");
    expect(classifyOutcome({ ok: false, status: 408, redirected: false, responseMs: 10 }).kind).toBe("retryable");
    expect(classifyOutcome({ ok: false, status: null, redirected: false, responseMs: 10, error: "socket hang up" }).kind).toBe("retryable");
    expect(classifyOutcome({ ok: false, status: null, redirected: false, responseMs: 5000, error: "timeout" }).kind).toBe("retryable");
  });

  it("treats redirects as terminal (never followed)", () => {
    const r = classifyOutcome({ ok: false, status: 302, redirected: true, responseMs: 10 });
    expect(r.kind).toBe("permanent");
  });

  it("treats other 4xx as permanent", () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      expect(classifyOutcome({ ok: false, status, redirected: false, responseMs: 10 }).kind).toBe("permanent");
    }
  });
});

describe("retry schedule", () => {
  it("backs off exponentially over ~24h, then stops", () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([60, 300, 900, 3600, 10800, 32400, 43200]);
    expect(retryDelaySeconds(1)).toBe(60);
    expect(retryDelaySeconds(7)).toBe(43200);
    expect(retryDelaySeconds(8)).toBeNull();
    expect(retryDelaySeconds(0)).toBeNull();
  });

  it("exhausts after MAX_ATTEMPTS recorded tries", () => {
    expect(MAX_ATTEMPTS).toBe(8);
    expect(isExhausted(7)).toBe(false);
    expect(isExhausted(8)).toBe(true);
    expect(isExhausted(99)).toBe(true);
  });
});
