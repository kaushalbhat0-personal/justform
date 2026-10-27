# Security Architecture v0

## Authentication & session
Provider behind an `AuthProvider` interface (Supabase Auth = impl #1). Email+password, magic link, OAuth (Google/Microsoft first). MFA/TOTP enforced for Admin+, optional otherwise; SSO/SAML post-MVP. Sessions: httpOnly secure cookies, short access + rotating refresh; membership resolved server-side per request (cache ≤60s, invalidate on role change/removal). Uniform responses (no account/tenant enumeration). Revoke = immediate session kill.

## Application defenses
CSRF: SameSite=Lax + origin check on mutations. XSS: React escaping + sanitizer for rich text + strict CSP (`default-src 'self'`, no inline except signed nonces); report-only → enforce pre-MVP. Uploads: allowlist MIME/ext, size caps, quarantine + AV, private bucket, short-TTL signed URLs, never serve SVG/HTML inline.

## SSRF / integrations / webhooks
Egress allowlist + DNS re-resolve, no cloud-metadata/loopback/private IPs, 5s timeout, 1MB cap, ≤3 redirects. Webhooks HMAC-SHA256 + timestamp skew 5min + backoff; secrets write-only + rotatable. OAuth tokens envelope-encrypted, never logged.

## API keys / OAuth
`prefix + 256-bit secret`; hash stored (+last4/prefix); scopes ⊆ creator perms (OAuth-ready set from day 1); expiry ≤1y; rotate (24h dual-active) + instant revoke; per-key usage + rate limits. OAuth: PKCE required, minimal scopes.

## Secrets & encryption
Vault/env only, never in repo; per-env separation; quarterly rotation; CI secret-scan. TLS 1.2+ transit; provider disk encryption + envelope-encrypted PII/secret columns. PII minimization: salted IP hash, truncated UA, no PAN anywhere (see payments).

## Backups / deletion / DSR
PITR + daily encrypted dumps, monthly restore drill. Soft-delete → 30d purge; DSR export/erase ≤30d including storage + logs (audit retains actor/action only, identifiers redacted). Workspace delete: Owner-confirmed, 30d recoverable, then hard purge per retention table.

## Rate limits / abuse
Intake 60/min/IP + captcha after threshold; auth 5/min + lockout; exports 5/hr/workspace; webhooks per-target backoff + circuit-breaker. WAF + Turnstile on public surfaces pre-launch. Abuse: quarantine workspace + alert — never silent-drop paying intake without notice.

## Audit & logging
Append-only `audit_log`: authz denials (sampled), grants, exports, admin, billing, key/webhook lifecycle. **Never log:** passwords, raw keys/secrets, OTPs, session tokens, PAN/UPI handles, full submission answers by default, file bytes, MFA seeds.

## AI boundaries (later, architecture-set now)
Untrusted prompts/attachments never auto-executed; tool calls allowlisted + human approval for destructive ops; PII redaction before model calls; output PII scan before render; models never see secrets/keys; no training on tenant data (contract + redaction).

## Payment boundaries
Never touch PAN: gateway Elements/Checkout only (PCI SAQ-A posture). Webhook signature verify + idempotency keys + amount-reconciliation job. Subscription state from gateway, cached in DB.

## E-sign boundaries (later)
Tamper-evident trail: hash-chained `status_history` + flattened completed PDF + detached signature manifest + trusted timestamp (RFC 3161).

## Requires legal/security review before launch/build
BAA stance + DPA (DPDP/GDPR); PCI SAQ-A confirmation letter; ESIGN/UETA + India IT-Act counsel (before any signature build); pen-test + CSP-enforcement sign-off; data-residency commitments before any region promise.
