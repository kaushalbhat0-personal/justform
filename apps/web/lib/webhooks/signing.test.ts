import { describe, expect, it } from "vitest";
import { parseSignatureHeader, signWebhook, verifyWebhookSignature } from "./signing";

const SECRET = "test-webhook-secret-value-0123456789";
const ALT_SECRET = "different-secret-value-9876543210abcd";
const BODY = JSON.stringify({ event: { id: "abc", type: "submission.created" } });

describe("webhook signing", () => {
  it("produces a stable header matching the documented format", () => {
    const { signature, header } = signWebhook(SECRET, 1_700_000_000, BODY);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(header).toBe(`t=1700000000,v1=${signature}`);
    // Deterministic: same inputs always agree (fixed vector for the harness).
    expect(signWebhook(SECRET, 1_700_000_000, BODY).signature).toBe(signature);
  });

  it("verifies authentic payloads and rejects everything else", () => {
    const { header } = signWebhook(SECRET, 1_700_000_100, BODY);
    expect(verifyWebhookSignature(SECRET, header, BODY, 1_700_000_100)).toBe(true);
    // Wrong secret.
    expect(verifyWebhookSignature(ALT_SECRET, header, BODY, 1_700_000_100)).toBe(false);
    // Tampered body.
    expect(verifyWebhookSignature(SECRET, header, `${BODY} `, 1_700_000_100)).toBe(false);
    // Replayed outside the ±5min window (old and future).
    expect(verifyWebhookSignature(SECRET, header, BODY, 1_700_000_100 + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, header, BODY, 1_700_000_100 - 301)).toBe(false);
    // Boundary: exactly at the edge is accepted.
    expect(verifyWebhookSignature(SECRET, header, BODY, 1_700_000_100 + 300)).toBe(true);
    // Malformed headers.
    expect(verifyWebhookSignature(SECRET, null, BODY, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "v1=abc", BODY, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "t=abc,v1=" + "0".repeat(64), BODY, 1_700_000_100)).toBe(false);
  });

  it("parses the signature header strictly", () => {
    expect(parseSignatureHeader("t=123,v1=" + "a".repeat(64))).toEqual({ t: "123", v1: "a".repeat(64) });
    expect(parseSignatureHeader(" t=123,v1=" + "a".repeat(64) + " ")).not.toBeNull();
    expect(parseSignatureHeader("t=123,v1=zzz")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });
});
