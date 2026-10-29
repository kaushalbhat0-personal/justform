import "server-only";
import { getServiceClient, verifyApiKeyHash, parseApiKey, type ApiScope } from "@formos/database";
import { checkRateLimit, type RateLimitResult } from "../public/rateLimit";
import { ApiError } from "./envelope";

export { requireScope } from "./scope";

/**
 * Authenticated API principal resolution (Phase 9).
 * Bearer `Authorization` header → workspace-bound key + scopes. Every read
 * below is explicitly workspace-scoped; the privileged client never touches
 * a row outside the key's workspace. No sessions, no impersonation.
 */

export type { ApiScope };
export const API_SCOPES: ApiScope[] = ["forms:read", "submissions:read", "webhooks:read", "billing:read"];

export interface ApiPrincipal {
  keyId: string;
  workspaceId: string;
  scopes: ApiScope[];
}

export interface ApiAuthResult {
  principal: ApiPrincipal;
  rateLimit: RateLimitResult;
  retryAfterSeconds?: number;
}

const AUTH_LIMIT = { windowMs: 60_000, max: 60 };
const KEY_LIMIT = { windowMs: 60_000, max: 300 };

function headerToken(req: { headers: { get(name: string): string | null } }): string | null {
  const raw = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m?.[1] ?? null;
}

/** Resolve + verify an API key. Throws ApiError (UNAUTHENTICATED) on any failure. */
export async function authenticateApiKey(
  req: { headers: { get(name: string): string | null }; ip?: string },
  now = Date.now(),
): Promise<ApiAuthResult> {
  const token = headerToken(req);
  if (!token) {
    throw new ApiError("UNAUTHENTICATED", "Missing or malformed Authorization header.", 401);
  }
  const parsed = parseApiKey(token);
  const client = getServiceClient();
  // Unauthenticated callers share one backstop bucket (guessing resistance).
  const anonLimit = checkRateLimit(`api:anon:${req.ip ?? "unknown"}`, AUTH_LIMIT, now);
  if (!anonLimit.ok) {
    throw new ApiError("RATE_LIMITED", "Too many requests.", 429, Math.ceil(anonLimit.retryAfterMs / 1000));
  }
  if (!parsed) {
    throw new ApiError("UNAUTHENTICATED", "Invalid API key.", 401);
  }
  const { data, error } = await client
    .from("api_keys")
    .select("id, workspace_id, secret_hash, scopes, revoked_at")
    .eq("key_prefix", parsed.prefix)
    .maybeSingle();
  if (error || !data) {
    throw new ApiError("UNAUTHENTICATED", "Invalid API key.", 401);
  }
  const row = data as { id: string; workspace_id: string; secret_hash: string; scopes: ApiScope[]; revoked_at: string | null };
  const ok = verifyApiKeyHash(token, row.secret_hash);
  if (!ok || row.revoked_at !== null) {
    throw new ApiError("UNAUTHENTICATED", "Invalid API key.", 401);
  }
  const keyLimit = checkRateLimit(`api:key:${row.id}`, KEY_LIMIT, now);
  if (!keyLimit.ok) {
    throw new ApiError("RATE_LIMITED", "Too many requests.", 429, Math.ceil(keyLimit.retryAfterMs / 1000));
  }
  // Best-effort usage stamp; never blocks the request path on failure.
  void client.from("api_keys").update({ last_used_at: new Date(now).toISOString() }).eq("id", row.id).then(
    () => undefined,
    () => undefined,
  );
  return {
    principal: { keyId: row.id, workspaceId: row.workspace_id, scopes: row.scopes },
    rateLimit: keyLimit,
  };
}
