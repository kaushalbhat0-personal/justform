import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential primitives for API keys + webhook secrets.
 * Lives in @formos/database (never apps/): secret env names and raw key
 * material must never appear in browser-reachable trees (G4).
 *
 * - API keys: `fm_live_<prefix>_<secret>`, prefix 12×[A-Za-z0-9] (identifier),
 *   secret 32 random bytes (base64url, 43 chars). Only SHA-256 hex is stored.
 * - Webhook signing secrets: 32 random bytes; AES-256-GCM encrypted at rest
 *   with WEBHOOK_ENCRYPTION_KEY (32 bytes, hex). Stored form:
 *   base64(iv[12] || ciphertext || tag[16]).
 */

/** `fm_live_<12 alnum>_<43 base64url>` — parseable without ambiguity. */
const KEY_RE = /^fm_live_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
export const API_KEY_SCOPES = ["forms:read", "submissions:read", "webhooks:read", "billing:read"] as const;
export type ApiScope = (typeof API_KEY_SCOPES)[number];

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateApiKey(): { fullKey: string; prefix: string; secret: string } {
  const bytes = randomBytes(12);
  let prefix = "";
  for (const b of bytes) prefix += ALNUM[b % ALNUM.length];
  const secret = randomBytes(32).toString("base64url");
  return { fullKey: `fm_live_${prefix}_${secret}`, prefix, secret };
}

export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey, "utf8").digest("hex");
}

export function parseApiKey(input: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(input.trim());
  if (!m?.[1] || !m[2]) return null;
  return { prefix: m[1], secret: m[2] };
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function verifyApiKeyHash(candidateFullKey: string, storedHexDigest: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHexDigest)) return false;
  const a = Buffer.from(hashApiKey(candidateFullKey), "hex");
  const b = Buffer.from(storedHexDigest, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isValidScope(value: string): value is ApiScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

function webhookEncryptionKey(): Buffer {
  const hex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("webhook secrets unavailable: misconfigured encryption key");
  }
  return Buffer.from(hex, "hex");
}

/** AES-256-GCM encrypt a webhook signing secret → base64(iv|cipher|tag). */
export async function encryptWebhookSecret(plaintext: string): Promise<string> {
  const key = webhookEncryptionKey();
  const iv = randomBytes(12);
  const cipher = (await import("node:crypto")).createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([iv, enc]).toString("base64");
}

/** Decrypt a value produced by encryptWebhookSecret. Throws on tamper/misconfig. */
export async function decryptWebhookSecret(stored: string): Promise<string> {
  const key = webhookEncryptionKey();
  const raw = Buffer.from(stored, "base64");
  if (raw.length < 12 + 16 + 1) throw new Error("webhook secret undecryptable");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const data = raw.subarray(12, raw.length - 16);
  const { createDecipheriv } = await import("node:crypto");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Constant-time CRON bearer check for the scheduled tick route. */
export function isCronAuthorized(headerValue: string | null | undefined): boolean {
  const m = /^Bearer\s+(.+)$/i.exec((headerValue ?? "").trim());
  const presented = m?.[1] ?? "";
  const expected = process.env.CRON_SECRET ?? "";
  if (!presented || !expected || expected.length < 32) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
