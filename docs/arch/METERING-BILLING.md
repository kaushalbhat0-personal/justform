# Metering & Billing — INR-first, no surprise charges

## Principles
Every billable action is metered BEFORE billed — no meter, no charge. INR-first (UPI-friendly). Confirm-before-charge on all overages. **NEVER data-hostage:** users can always view/export/delete their data; only NEW intake freezes on non-payment.

## Meters (canonical)
Core: `forms` (published count), `submissions`/mo, `views`, `storage_bytes`, `uploads`, `api_calls`, `webhook_deliveries`. Reserved + flagged (NOT MVP): `workflow_executions`, `payments_volume`, `sign_envelopes`, `ai_credits`. Dimensions: `members`, `workspaces`, `custom_domains`. Seat overage = hard-blocked invite with upgrade nudge.

## Pipeline: counters + ledger
`usage_counters (workspace_id, meter, period_start, used, limit)` — transactional increments in the same txn as the gated action (views/API async, submissions/storage sync). `usage_ledger (workspace_id, meter, day, qty, source)` — immutable daily rollups, append-only; hourly reconcile `SUM(ledger) → fix drift`. Ledger is billing truth in disputes.

## Pooled limits / hard vs soft
Limits pool at the workspace (not per form/user); dashboard shows top consumers. Drafts unlimited (never punish iteration); published forms count.
| Meter | At limit | Why |
|---|---|---|
| submissions, storage, members, uploads | HARD block + upgrade CTA | cost/durability risk |
| views, api_calls, webhook_deliveries | SOFT (throttle + warn, 10% grace) | preserve intake, avoid loss |
Hard block: `402 plan_limit` + upgrade hint + friendly public form-closed page (never a 500).

## Warnings, grace, downgrade, cancel
Warnings at 80% + 100% (in-app, email, `billing.limit_warned`) to owner/billing contacts. Grace: 7d overage window on soft meters; 48h submission-spool on hard meters (accept then freeze new intake, never delete). Downgrade: limits immediate, excess usage read-only 30d + export, no retroactive charge, credits carry over. Cancel → Free: data retained 90d + export window (CSV/PDF/full JSON); then soft-delete → purge. NEVER instant delete on cancel.

## Overages & top-ups
No auto-charge. Overage in MVP = freeze new intake + upgrade CTA (no payment taken). Live checkout, paid top-ups/overages, and refunds are V1 (gated by ADR-020 + counsel-reviewed billing terms). MVP proration/refund math is specified but not wired to money movement.

## Provider: port now, money in V1 (FIX-001 reconciliation)
**MVP:** plan definitions, entitlements, counters + ledger, quota enforcement, usage screen, upgrade CTA, and the `BillingProvider` port as a **dead interface** (no live keys, no checkout, no subscriptions/invoices/refunds/top-ups). Razorpay primary (INR/UPI/GST) + Stripe secondary are SELECTED but not integrated — V1 work.
**V1 (gated by ADR-020 + billing-terms review):** live checkout, subscriptions, invoices, prorated upgrades/downgrades, paid top-ups/overages (explicit confirm-before-charge), refunds (`refund_requested/approved/denied` + reason + audit; auto pro-rata annual-cancel ≤7d, else manual). App never calls provider SDKs directly; provider webhooks signature-verified + deduped on provider event id; entitlement state lives in OUR DB. Disputes freeze auto-debit, never data.

## Transparency UX (required, not optional)
Usage screen + `GET /v1/workspaces/:id/usage` show per meter: `used / limit / resets-in`, projected run-out, top forms, upgrade/top-up CTA. Every block/warn deep-links with `?meter=…`. Invoices itemize meter × qty × rate in ₹.
