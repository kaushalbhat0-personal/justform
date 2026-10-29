/**
 * Unguessable public identifiers (Phase 6).
 * 128-bit base64url, URL-safe, non-sequential — never an internal form UUID.
 * Pure module (no server-only import) so the contract is unit-testable.
 */
import { randomBytes } from "node:crypto";

export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function generatePublicId(): string {
  return randomBytes(16).toString("base64url");
}
