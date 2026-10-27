# Queue & Workers — ADR-012 (reconciled — FIX-001)

## Status
DECIDED: MVP = **Option A — scheduled bounded outbox processor** (no persistent process). V1 = pg-boss (default bias) or Inngest. Temporal only for durable human-in-loop at scale.

## Context
MVP load <100k jobs/mo, bursty. Stage 0 = serverless (no process may be assumed to run indefinitely). Jobs: webhook delivery, email, AV callback, rollups, cleanup, scheduled reports.

## Stage 0 mechanism — canonical answer (P0 decision)
**Scheduled HTTPS tick → internal bounded batch route → Postgres outbox.** Concretely: the hosting platform's scheduler (e.g. Vercel Cron or equivalent — provider-neutral requirement, not a Vercel API) invokes `POST /api/internal/outbox-tick` on a fixed cadence. The route: (1) authenticates via `CRON_SECRET` bearer (no session, no API key, rotated per env; wrong/missing → 401, no work); (2) acquires `pg_try_advisory_lock('outbox_tick')` — losers exit 200 immediately (single-flight, no overlapping batches); (3) claims a bounded batch (`SELECT … FOR UPDATE SKIP LOCKED`, cap **N=100 rows or T=50s wall-clock, whichever first** — never unbounded); (4) executes handlers idempotently (dedupe on `event_id` via `processed_events`); (5) commits per-message (or small sub-batches) so one poison message cannot roll back the batch; failures set `next_retry_at` (exponential `2^n × 5s`, max 8, ±20% jitter) or `dead` + alert; (6) always releases the advisory lock (try/finally) and returns a JSON summary (claimed/succeeded/failed/dead) for observability.

- **Invocation model:** pull-by-schedule, not push; cadence **60s** (tunable 15–300s by queue depth — adaptive: consecutive full batches halve the interval floor, consecutive empty batches back off to 300s).
- **Timeout/concurrency:** single-flight per batch (advisory lock); function must finish < platform timeout (budget 50s work + margin); webhook deliveries run in a separate claim pool (separate lock key) so slow customer endpoints cannot starve notifications.
- **Retry/DLQ:** in-row `attempts/next_retry_at/status`; exhausted → `dead` + alert + admin-only audited replay. Webhooks: 8 retries over ~24h, then `failed`; auto-disable subscription at 50 consecutive failures.
- **Failure recovery:** crash mid-batch → lock auto-releases on session end; un-acked claimed rows (lease column `claimed_until`) are re-claimable after lease expiry — no stuck messages, no duplicates beyond idempotent re-execution.
- **Fairness:** `ORDER BY next_retry_at` + per-workspace throttle counter per tick (cap share per `workspace_id` per batch) so one viral form cannot starve others.
- **Transactional outbox remains source of truth:** domain mutations still write `outbox` rows in-txn; the tick is only the delivery pump. No lost events (rows persist), no dual-write.

## Alternatives Considered (and why not Stage 0)
- **B) Postgres/Supabase-scheduled invocation + bounded processing (pg_cron + pg_net):** rejected for Stage 0 — free-tier extension control is limited, `pg_net` in the delivery path reintroduces the extension-in-hot-path risk rejected in ADR-006, and failure observability is worse than an HTTPS tick with structured logs.
- **C) Separate free/low-cost worker runtime:** rejected — violates the one-deployable modular-monolith rule, adds a second deploy/secret/scaling story for zero architectural gain at MVP volumes; revisit only if tick throughput proves insufficient (then pg-boss, not a bespoke runtime).
- **D) Any other ₹0 mechanism (client-polling triggers, in-request piggyback processing):** rejected — client-driven execution is attacker-influenced and breaks fairness/quotas; in-request piggybacking couples user latency to queue depth.

## V1 / eventual (unchanged)
V1 when p95 dispatch lag >10s sustained or >1M events/mo: pg-boss if Postgres-centric/cost-sensitive (no per-run billing); Inngest if step-functions/long sleeps justify per-run cost. Temporal only for durable multi-day approvals at scale — never before PMF, never Kafka before $50k MRR or multi-region.

## MVP design tables
`outbox` + `scheduled_jobs (name, payload_ref, run_at, status, attempts)` + `processed_events`. Scheduled ticker row doubles as the cron-heartbeat monitor (missed ticks → alert). `scheduled_jobs` covers daily rollups, limit warnings, draft/upload GC, report emails; `(name, run_at)` unique; missed runs catch up once, then skip.

## Consequences / Security / Performance / Cost
No Redis/repo/deploy, no >60s request work, no per-tenant queues. Tick route accepts ONLY the cron secret (scope-isolated, rate-limited, not in the public API surface, excluded from OpenAPI). Cost ₹0 until V1 triggers.

## Migration
Outbox → pg-boss: depth >10k sustained, throttling/cron-UI need, or tick-handler CPU >20%. Handlers are already idempotent + `event_id`-keyed, so the swap is transport-only.

## Open Questions
Exact V1 pick (pg-boss vs Inngest) decided by measured lag + team size at the trigger — not now.
