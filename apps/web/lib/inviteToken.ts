import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation tokens (server-only). 256-bit random token; only the SHA-256 hex
 * digest is stored (token_hash). Raw tokens never touch logs, analytics, or DB.
 */
export interface TokenPair {
  token: string;
  hash: string;
}

export function generateInvitationToken(): TokenPair {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function invitationLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/app/invite/${token}`;
}
