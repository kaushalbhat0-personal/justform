# Events & Async — outbox first, no Kafka at MVP

## Principles
DB is source of truth — no event without committed state. Async for side-effects only (webhooks, notifications, AV callback, meters, audit fan-out). Never block the request path on network I/O: enqueue in-txn, return fast. No Kafka/Redpanda/Kinesis at MVP (₹0, unjustified ops cost).

## Envelope (v1)
`{ event_id (uuidv7, unique), schema_v, type, workspace_id, actor {id, type}, occurred_at, correlation_id, request_id, resource {type, id, form_id}, payload_ref {table, id}, payload (minimal, never full PII) }`. Rules: `payload_ref` preferred over inline data; NEVER answers blobs, files, or PAN in payload — workers fetch by ref under RLS/service-role. `schema_v` per event type; additive-only changes, breaking = new version.

## Classes
Domain (state changed, internal: `form.published`, `submission.completed`), Integration (deliver to customer: `webhook.delivery_requested`, `notification.requested`), Audit (compliance trail: `submission.exported`, `role.changed`). Domain→audit projection is one-way; audit never re-emits domain events.

## Canonical list (MVP)
`form.published/unpublished` · `submission.started/completed/spam_flagged` · `submission.assigned/status_changed/comment_added` · `file.uploaded/scanned` · `webhook.delivery_requested/succeeded/failed` · `notification.requested/sent/failed` · `billing.limit_warned (80/100%)/limit_exceeded`. Reserved, NOT MVP: `workflow.*`, `payment.*`, `ai.*`.

## Transport: Postgres outbox + scheduled bounded tick (no persistent process)
`outbox (event_id PK, workspace_id, type, schema_v, correlation_id, payload_ref, payload, status, attempts, next_retry_at, claimed_until, created_at)` written in the same txn as the domain mutation (no dual-write). Delivery pump = scheduled HTTPS tick (`/api/internal/outbox-tick`, cron-secret authenticated, `pg_try_advisory_lock` single-flight) claiming bounded batches (`FOR UPDATE SKIP LOCKED`, N≤100 or 50s wall-clock) and dispatching to a handler registry by `type`. Handlers must be idempotent (dedupe on `event_id` via `processed_events`). Crash-mid-batch is safe: lock auto-releases, `claimed_until` lease expiry re-queues, re-execution is idempotent. Full mechanism in QUEUE-WORKERS.md.

## Retry / backoff / DLQ
Exponential `2^n × 5s`, max 8 attempts (~1h), ±20% jitter. Retryable: 5xx, timeout, rate-limit, AV-pending. Non-retryable: 4xx validation, unknown schema, tenant deleted. Exhausted → `status=dead` + alert + admin-only audited replay. Webhooks: 8 retries over ~24h, then `failed`; auto-disable subscription after 50 consecutive failures.

## Ordering
No global ordering. Per-resource ordering via `(resource.id, occurred_at, event_id)` where needed (status changes). Consumers tolerate out-of-order delivery.

## Promotion path (explicit)
MVP: outbox + scheduled bounded tick. → V1: pg-boss (default bias, Postgres-centric) or Inngest (if step-functions/long sleeps needed) when p95 dispatch lag >10s sustained or >1M events/mo. → Temporal only for durable multi-day human-in-loop workflows at scale. NEVER Kafka before $50k MRR or a multi-region requirement — documented here so it isn't relitigated without cause.

## Non-goals
No event sourcing (events notify, DB stores state). No cross-workspace events (exactly one `workspace_id` per event).
