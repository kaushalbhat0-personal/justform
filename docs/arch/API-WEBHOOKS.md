# API & Webhooks — REST v1 contract

## Versioning
`/api/v1/...` + optional `API-Version: 2026-10-28` header (echoed; URL wins). Breaking change → new date-versioned behavior, old supported 12mo. Additive fields anytime. SDKs pin; dashboard uses latest.

## Resource naming
Plural nouns, kebab-case. Tenant scope nested: `/v1/workspaces/:ws_id/forms/:form_id/submissions`. Top-level only for non-tenant (`/v1/plans`, `/v1/health`). Everything customer-data under `:ws_id`. Actions as sub-resources: `/submissions/:id/assign`, `/forms/:id/publish`. No verbs in base paths.

## Workspace authority — URL is a locator, NEVER an authorization source
`session/API key → authenticated principal → workspace membership / key binding → resource authorization → RLS`. The `:ws_id` path segment is resolved to a resource locator and then **discarded as an authority signal**:
- **Browser/session API:** the session's membership set is loaded server-side; the requested `:ws_id` must be a member workspace AND the target resource must be re-resolved under that workspace (composite `(workspace_id, id)` lookup). URL/resource mismatch (resource belongs to another workspace the caller also belongs to) → resolve within the URL workspace or 404 — never silently serve the other workspace's row.
- **API-key access:** the key is bound to exactly one workspace at mint (`api_keys.workspace_id`, immutable). Every call re-checks `key.workspace_id == resource.workspace_id`; a key calling `/v1/workspaces/<other>/…` gets a uniform 404 (never a 403 that confirms existence). Keys cannot escape their binding: scopes ⊆ creator's permissions at mint, rotation preserves binding, and a leaked key yields at most one workspace's grant-scoped data.
- **RLS backstop:** even if the app tier ever passed the wrong workspace, RLS (membership + composite-FK checks) denies. URL authority is defense-in-depth layer zero — it is not a layer at all.

## Pagination / filtering / sorting
Cursor only: `?limit=50&cursor=opaque` → `{data[], page:{next_cursor, has_more}}`. No offset (breaks on live tables). `limit` default 25, max 100. `sort=-created_at,field_key` (`-` = desc, per-resource allowlist). Filters `?status=new,assigned&form_id=...&created_after=...&q=...`; unknown params ignored (never 400). `q` = prefix/trigram, documented per resource.

## Error envelope + rate-limit headers
`{ error: { code (snake_case, stable), message, details, request_id } }` — HTTP status + `code` + always-present `request_id`. Every response carries `RateLimit-Limit/Remaining/Reset` (+ `X-Limit-Left` alias); 429 adds `Retry-After` with `code=rate_limited`.

## Authentication + API keys
`jf_live_<lookup><256-bit secret>` / `jf_test_...`. Stored: SHA-256 hash + prefix + last4; raw secret shown ONCE. Scopes (OAuth-ready from day 1): `forms:read/write`, `submissions:read/write`, `webhooks:manage`, `billing:read`, `admin`. Key bound to one workspace, optional expiry ≤1y + IP allowlist (V1). Rotation: create → 24h dual-active → revoke old (audited). `last_used_at` + per-key rate limits; revoke instant.

## Idempotency (POST)
`Idempotency-Key: <client uuid>` required on submission-create, key-create, webhook-create. Server stores `(key, workspace, response-hash, 24h)`; replay → same response (200, not 201); same key + different body → 422 `idempotency_conflict`.

## Webhook subscriptions
`workspaces → webhooks (url, events[], secret write-only, status, failures)`. URL policy: https only (http for localhost/test), optional domain allowlist, **deny private/loopback/metadata IPs** via egress check (SSRF guard, no redirect-following). Signing: `X-Signature: t=<ts>,v1=<HMAC-SHA256(raw_body, secret)>`, ±5min replay window, sample verifier in docs. Retries exponential over ~24h (8 attempts), 10s timeout; 50 consecutive failures → auto-disable + notice + audit. Delivery-log API (`GET /v1/webhooks/:id/deliveries`, `POST /:delivery_id/redeliver`), 30d retention (90d paid).

## OAuth2 + MCP future-proofing (no rewrite)
Day-1 scope check (`has_scope(token, required)`) is shared by the future OAuth issuer. Future: Authorization Code + PKCE → short-lived JWT (`aud=workspace, scp=scopes`) + refresh rotation. MCP tools map 1:1 to REST (`forms.create`, `submissions.list`) reusing the same scope gate + RLS. No new auth model. No GraphQL/gRPC at MVP; no public write without a key, except public form fill which follows the two-layer path only (API/BFF Zod → scoped intake RPC, SUBMISSION-PIPELINE.md) — never direct table writes, never service-role in the request path.

## Security / performance notes
Scope check + membership/key-binding check + RLS on every call (three independent gates); key hash lookup indexed by prefix; delivery logs truncated (no secret/PII bodies); per-target circuit-breaker so one slow customer can't stall the pool.
