# Audit & Observability — prove it later

## Audit log (append-only)
`audit_log (id, occurred_at, workspace_id, actor {id/type}, action, resource_type/id, before/after JSONB diff, ip_hash, device, request_id, correlation_id)`. INSERT-only (no UPDATE/DELETE; Admin+ read own workspace). `before/after` = minimal diff, secrets/PII-redacted. Every mutation emits exactly one row in the same txn (outbox pattern reuse).

## Must-audit coverage
Auth/security (login, logout, MFA, reset, key created/revoked/anomaly, invite accepted, session revoked) · roles (granted/revoked, workspace transfer) · forms (created, schema changed with version + diff hash, published/unpublished, deleted/restored) · submissions (status_changed, assigned, comment_added, deleted, exported, spam override) · data access (export/download, API key use, secret accessed — which, never value, integration connected/disconnected) · billing (plan changed, top-up, refund, limit override, payment failed) · later: workflow approvals, AI actions (prompt hash + decision, never full PII).

## Retention & export
Hot 90d in PG (indexed). Cold 1yr+ in cheap object storage (Parquet/JSONL, per-workspace prefix). Enterprise: 3yr + SIEM push + signed CSV export. Purge only by retention job (audited); legal-hold flag suspends purge per workspace.

## Observability: logs / metrics / tracing / errors
Structured JSON everywhere: `{ts, lvl, svc, req, corr, ws, actor, action, latency_ms, code}`; request → correlation → event → worker chain preserved. Public renderer: 100% error sampling, 10% success. Metrics: RED per module (forms/submissions/tables/renderer) + pipeline (queue depth, dispatch lag, attempts, webhook success %, AV lag, notification drops) + billing (usage-vs-limit, overage blocks, provider failures) + RLS-denial counts (spike = bug or attack). Tracing: OTel across Next → PG → workers → outbound webhook (`traceparent` + `correlation_id`; 100% traces on renderer errors and DLQ). Errors: Sentry (self-hostable, ₹0), source-mapped, release-tagged, PII-scrubbed; alert on new issue types.

## NEVER-log list
Passwords, raw API keys/secrets, OTPs, session tokens, PAN/UPI handles, full submission answers by default, file bytes, MFA seeds, webhook signing secrets, OAuth refresh tokens. Debug need? Log `resource_id + field hashes`, fetch actuals via audited admin read. Violation = P1 + audit entry.

## Dashboards & alerts (MVP minimum)
Dashboards: request health, queue/pipeline, usage/billing, security (logins, key use, RLS denials). Alerts: 10× usage spike (billing anomaly), RLS-violation burst, queue lag >5min, AV failure >1%, webhook fail >10%/15min, p99 renderer >2s. Every alert links to runbook + `request_id` query and has an owner; silence-with-reason is audited.
