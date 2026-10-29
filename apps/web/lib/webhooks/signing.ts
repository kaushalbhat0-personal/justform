import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook request signing (HMAC-SHA256, Phase 9).
 * Canonical format: signature covers `t + "." + rawBody`.
 * Header: `x-formos-signature: t=<unix>,v1=<hex>`.
 * Pure functions — unit-tested with fixed vectors; no I/O.
 */

export interface SignedPayload {
  headers: Record<string, string>;
  body: string;
}

const REPLAY_WINDOW_SECONDS = 300;

export function signWebhook(secret: string, timestampUnix: number, rawBody: string): { signature: string; header: string } {
  const t = String(timestampUnix);
  const signature = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return { signature, header: `t=${t},v1=${signature}` };
}

export function parseSignatureHeader(value: string | null | undefined): { t: string; v1: string } | null {
  if (!value) return null;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(value.trim());
  if (!m?.[1] || !m[2]) return null;
  return { t: m[1], v1: m[2] };
}

/**
 * Verify a received webhook. Returns false on any mismatch, malformed
 * header, replayed timestamp, or wrong secret — never throws for bad input.
 */
export function verifyWebhookSignature(
  secret: string,
  signatureHeader: string | null | undefined,
  rawBody: string,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const t = Number(parsed.t);
  if (!Number.isFinite(t) || Math.abs(nowUnixSeconds - t) > REPLAY_WINDOW_SECONDS) return false;
  let expected: string;
  try {
    expected = createHmac("sha256", secret).update(`${parsed.t}.${rawBody}`, "utf8").digest("hex");
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.v1, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
