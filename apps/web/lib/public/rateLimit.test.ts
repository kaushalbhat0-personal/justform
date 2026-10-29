import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rateLimit";

describe("public rate limiter (single-instance backstop)", () => {
  beforeEach(() => resetRateLimits());

  it("allows bursts up to the configured max", () => {
    const cfg = { windowMs: 60_000, max: 3 };
    expect(checkRateLimit("k", cfg, 1000)).toEqual({ ok: true });
    expect(checkRateLimit("k", cfg, 1001)).toEqual({ ok: true });
    expect(checkRateLimit("k", cfg, 1002)).toEqual({ ok: true });
    const blocked = checkRateLimit("k", cfg, 1003);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("scopes counters per key", () => {
    const cfg = { windowMs: 60_000, max: 1 };
    expect(checkRateLimit("a", cfg, 0).ok).toBe(true);
    expect(checkRateLimit("b", cfg, 0).ok).toBe(true);
    expect(checkRateLimit("a", cfg, 0).ok).toBe(false);
  });

  it("releases the window after expiry", () => {
    const cfg = { windowMs: 1000, max: 1 };
    expect(checkRateLimit("k", cfg, 0).ok).toBe(true);
    expect(checkRateLimit("k", cfg, 500).ok).toBe(false);
    expect(checkRateLimit("k", cfg, 1001).ok).toBe(true);
  });
});
