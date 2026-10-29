import { describe, expect, it } from "vitest";
import { verifyCaptcha } from "./captcha";

const okFetch = async () =>
  new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
const denyFetch = async () =>
  new Response(JSON.stringify({ success: false }), { status: 200, headers: { "content-type": "application/json" } });

describe("captcha boundary", () => {
  it("skips verification when no secret is configured (documented fail-open)", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const verdict = await verifyCaptcha("any-token", "127.0.0.1", okFetch);
    expect(verdict).toEqual({ ok: true, skipped: true });
  });

  it("enforces verification when configured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    try {
      expect(await verifyCaptcha(undefined, undefined, okFetch)).toEqual({ ok: false, skipped: false });
      expect(await verifyCaptcha("tok", "1.2.3.4", okFetch)).toEqual({ ok: true, skipped: false });
      expect(await verifyCaptcha("tok", "1.2.3.4", denyFetch)).toEqual({ ok: false, skipped: false });
      const down = async () => {
        throw new Error("network down");
      };
      // Provider unreachable while enforced: fail closed.
      expect(await verifyCaptcha("tok", "1.2.3.4", down)).toEqual({ ok: false, skipped: false });
    } finally {
      delete process.env.TURNSTILE_SECRET_KEY;
    }
  });
});
