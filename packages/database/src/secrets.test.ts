import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_KEY_SCOPES,
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateApiKey,
  hashApiKey,
  isCronAuthorized,
  isValidScope,
  parseApiKey,
  verifyApiKeyHash,
} from "./secrets.js";

const HEX64 = /^[0-9a-f]{64}$/;

describe("API key primitives", () => {
  it("generates parseable keys with 256-bit-equivalent secrets", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.fullKey).not.toBe(b.fullKey);
    expect(a.prefix).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(a.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(a.fullKey);
    expect(parsed).toEqual({ prefix: a.prefix, secret: a.secret });
  });

  it("rejects malformed key strings without throwing", () => {
    for (const bad of ["", "fm_live_", "fm_live_short_x", "fm_live_" + "A".repeat(12), " bearer fm_live_" + "A".repeat(12) + "_" + "b".repeat(43)]) {
      expect(parseApiKey(bad)).toBeNull();
    }
    // Wrong scheme prefix is rejected before any DB lookup happens.
    expect(parseApiKey(`basic ${"A".repeat(12)}_${"b".repeat(43)}`)).toBeNull();
  });

  it("hashes deterministically to SHA-256 hex and verifies in constant time", () => {
    const { fullKey } = generateApiKey();
    const h1 = hashApiKey(fullKey);
    const h2 = hashApiKey(fullKey);
    expect(h1).toMatch(HEX64);
    expect(h1).toBe(h2);
    expect(verifyApiKeyHash(fullKey, h1)).toBe(true);
    expect(verifyApiKeyHash(fullKey.slice(0, -1) + (fullKey.endsWith("A") ? "B" : "A"), h1)).toBe(false);
    expect(verifyApiKeyHash(fullKey, "0".repeat(64))).toBe(false);
    expect(verifyApiKeyHash(fullKey, "not-hex")).toBe(false);
  });

  it("validates the documented scope set", () => {
    expect([...API_KEY_SCOPES].sort()).toEqual(["billing:read", "forms:read", "submissions:read", "webhooks:read"]);
    expect(isValidScope("forms:read")).toBe(true);
    expect(isValidScope("admin")).toBe(false);
    expect(isValidScope("")).toBe(false);
  });
});

describe("webhook secret encryption", () => {
  const OLD = process.env.WEBHOOK_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.WEBHOOK_ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // 32 bytes, test-only
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.WEBHOOK_ENCRYPTION_KEY;
    else process.env.WEBHOOK_ENCRYPTION_KEY = OLD;
  });

  it("round-trips secrets and rejects tampered ciphertext", async () => {
    const enc = await encryptWebhookSecret("whsec_test_secret_value");
    expect(enc).not.toContain("whsec_test_secret_value");
    expect(await decryptWebhookSecret(enc)).toBe("whsec_test_secret_value");
    // Flip one byte → auth tag failure, never plaintext.
    const raw = Buffer.from(enc, "base64");
    const target = raw[20];
    if (target === undefined) throw new Error("unreachable in test");
    raw[20] = target ^ 0x01;
    await expect(decryptWebhookSecret(raw.toString("base64"))).rejects.toThrow();
    await expect(decryptWebhookSecret("!!!not-base64!!!")).rejects.toThrow();
  });

  it("refuses to operate without a valid 32-byte key", async () => {
    process.env.WEBHOOK_ENCRYPTION_KEY = "short";
    await expect(encryptWebhookSecret("x")).rejects.toThrow(/misconfigured/);
    delete process.env.WEBHOOK_ENCRYPTION_KEY;
    await expect(encryptWebhookSecret("x")).rejects.toThrow(/misconfigured/);
  });
});

describe("isCronAuthorized", () => {
  const OLD = process.env.CRON_SECRET;
  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret-with-32-chars-min!!";
    vi.stubEnv("CRON_SECRET", "test-cron-secret-with-32-chars-min!!");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (OLD === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD;
  });

  it("accepts exact bearer tokens and rejects everything else", () => {
    const good = "Bearer test-cron-secret-with-32-chars-min!!";
    expect(isCronAuthorized(good)).toBe(true);
    expect(isCronAuthorized("Bearer wrong")).toBe(false);
    expect(isCronAuthorized("test-cron-secret-with-32-chars-min!!")).toBe(false);
    expect(isCronAuthorized(null)).toBe(false);
    expect(isCronAuthorized(undefined)).toBe(false);
    expect(isCronAuthorized("")).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(isCronAuthorized("Bearer anything")).toBe(false);
  });
});
