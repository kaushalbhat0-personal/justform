# RLS Threat Model — pre-MVP sign-off

**Principle:** deny-by-default. Tenant identity from server-verified session only. Service-role isolated to workers/RPC.

## Per-table-group policy intent (plain language; SQL lands in `packages/database` migrations + RLS tests)
- **workspaces:** SELECT iff active member. UPDATE iff Admin+. DELETE iff Owner. INSERT via creation RPC only (creates Owner membership atomically). No anon.
- **memberships:** SELECT iff same-workspace member (non-sensitive columns). INSERT/UPDATE/DELETE **RPC-only** (blocks self-escalation, last-owner removal). No direct client writes.
- **invitations:** SELECT/INSERT/revoke iff Admin+. Accept = invitee-only RPC with email match. Anon SELECT none (token verified inside RPC, uniform error).
- **forms / drafts / versions / publications:** member+grant reads (drafts: author/Builder+); Builder+ writes; Admin+ deletes published; versions INSERT-only (immutable); publications toggled by Builder+; public reads only through the redacted published-form RPC.
- **submissions + index/attachments/comments/tags/assignments/status_history:** SELECT iff Builder+/assignee/grant; UPDATE iff assignee-scope or Builder+; DELETE iff Admin+. **NO anon INSERT/SELECT/UPDATE/DELETE on any of these tables — public intake is RPC-only** (scoped SECURITY DEFINER intake function, no SELECT-back; see SUBMISSION-PIPELINE.md). Attachments served via signed URLs minted after a grant check.
- **table_views:** member+grant read; Builder+ write. No anon except explicitly published redacted view RPC.
- **integrations / runs:** config SELECT/CRUD Admin+ (secrets write-only); runs readable Admin+/owning Builder. Workers use service-role with minimal payload.
- **webhooks / deliveries:** manage Admin+; deliveries Admin+ read; secrets never returned (mask + rotate API).
- **api_keys:** manage Admin+; runtime scope checks server-side. Hash only in DB; prefix for lookup.
- **workflows (later):** author Builder+; execution worker-only. No direct client trigger except allowlisted entry RPC.
- **documents / payments (later):** PII/finance posture — Admin+/payee scope; gateway-only PAN; e-sign trail append-only.
- **audit_log:** INSERT via RPC/worker; SELECT Admin+. No UPDATE/DELETE by anyone, including owners.
- **counters:** worker/RPC increment only; member read for own quotas. No client writes.

Privileged worker access allowed only in: intake fan-out (read-only post-commit), webhook delivery, integration runs, scheduled reports, quota rollups — each with a `workspace_id`-pinned payload + audit row. The intake RPC itself runs SECURITY DEFINER (hardened per SUBMISSION-PIPELINE.md) and is the ONLY anonymous write path in the system.

Public access (exhaustive): redacted published-form metadata (read-only RPC), intake RPC invocation (write-only, receipt-only response), explicitly published view/report link. Everything else requires membership. There is deliberately NO anonymous table-level INSERT policy anywhere.

## Threats
- **T1 Cross-tenant read (A→B SELECT):** replay valid session with B's IDs. Control: RLS `workspace_id` + membership on every table. Test: A-member reads B rows → 0 rows/deny.
- **T2 Cross-tenant write (A→B UPDATE/DELETE):** forged `workspace_id`, guessed UUID. Control: server ignores client `workspace_id`; RLS blocks. Test: 0 rows affected.
- **T3 IDOR (sequential/guessable IDs):** enumerate `/forms/123`. Control: UUIDv7 IDs + workspace-scoped lookup + uniform 404. Test: neighbor-ID sweep → all 404.
- **T4 Self-role escalation:** PATCH own membership to Owner. Control: membership writes RPC-only; blocks self-target + higher-role grants. Test: denied + audited.
- **T5 Invitation abuse:** reuse/forge token, higher-role invite, email enumeration. Control: hashed single-use tokens, 7d expiry, role ≤ inviter, uniform errors. Test: replay/expired/forged → reject; higher-role invite → deny.
- **T6 Public-submission abuse:** flood intake, XSS, oversized files. Control: transport checks (rate limit + Turnstile + honeypot) BEFORE any DB touch; API-layer Zod validation (422, no RPC call on failure); all writes inside the hardened intake RPC (publication verified server-side, workspace resolved from publication, caller workspace ignored, caps/schedule/unique enforced in-txn) with RPC-side defensive shape checks as integrity floor; allowlist, size caps, quarantine + AV, no SELECT-back. Test: 1k burst + XSS + EICAR → throttled/quarantined/escaped, nothing executes, no table directly writable by anon.
- **T7 Service-role leakage:** key in browser bundle/API route. Control: worker-env only, lint + CI secret-scan, per-env keys. Test: bundle grep + call worker RPC with anon key → deny.
- **T8 Signed-URL abuse:** share/guess attachment URL. Control: short TTL, per-request membership check at mint, private bucket, no listing. Test: expired/foreign-workspace URL → 403.
- **T9 Webhook secret exposure:** read secret via GET, leak in logs. Control: write-only secrets, masked reads, rotate API, never-log list. Test: GET shows mask; logs contain no secret.
- **T10 Export exfiltration:** Viewer/scraped bulk export. Control: explicit `export` grant + Admin/Builder gate, async audited job, redacted to grant scope, rate-limited. Test: Viewer → deny; Builder → audit row + redacted output.

## MANDATORY pre-MVP integration tests (all must pass)
1. A-member reads B form/submission/table → denied/empty. 2. A-member updates/deletes B row → 0 rows + denial audit. 3. A-member exports B data → denied. 4. Public link reads private (unpublished) form → 404; published → redacted metadata only. 5. Member attempts admin op (invite/delete/integration/API) → denied. 6. Anon direct INSERT to ANY table (submissions, memberships, forms) → denied (no anon table grants exist). 7. Grant self-escalation: direct INSERT to grants as Viewer, or crafted higher-role grant → denied (grants are RPC-minted only). 8. Cross-workspace URL swap: valid session/key for workspace A calling `/v1/workspaces/<B>/…` → 404 (never 403-with-confirmation). 9. Expired/replayed invitation, or accept with non-matching email → rejected. 10. Foreign/expired signed URL → 403. 11. Intake/worker RPC called with anon/auth key outside its allowed caller → denied. 12. `workspace_id` UPDATE attempt on any row → rejected (immutability trigger).
