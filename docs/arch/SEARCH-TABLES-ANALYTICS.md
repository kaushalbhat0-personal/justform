# Search, Tables & Analytics — Postgres first, no ES at MVP

## Status
DECIDED (accepted 2026-10-28).

## Search (no Elasticsearch at MVP — justified)
Postgres FTS + trigram (`pg_trgm`) for inbox/form search + GIN on `answers` JSONB + b-tree on the materialized `submission_index` (ADR-009). External engine (Typesense/self-hosted) explicitly deferred until: index size >50GB, fuzzy-across-workspaces need, or FTS p95 >800ms — whichever first, measured not assumed. Rationale: ES-class infra is unjustified ops + cost pre-PMF; PG covers 1k–100k comfortably.

## Tables scaling plan (server-driven, never load-everything)

| Rows/form | Strategy |
|---|---|
| 1k | client fetch + sort/filter OK |
| 10k | server pagination (keyset) + column projection; saved filters run server-side |
| 100k | keyset + saved-filter materialization + covering indexes on `submission_index` |
| 1M+ | read replica + per-form rollup tables + bulk path = async CSV export (never full-grid render) |

Exports are async audited jobs (grant-gated), never synchronous full scans from the browser.

## Analytics separation (operational vs analytical — never scan millions per dashboard)
- **Operational (transactional):** `usage_counters` incremented in-txn (caps, quotas). Reads are O(1) per meter.
- **Analytical (immutable daily rollups):** `analytics_daily (workspace_id, form_id, day, views, starts, completes, per-field drop-offs, utm_source…)` written by workers from events. Dashboards read rollups ONLY.
- **Drop-off tracking:** step-impression events (`form.viewed`, `step.seen`, `submission.completed`) with field-scoped, PII-free payloads; funnel computed at rollup time, not query time. Privacy-safe by construction (counts, not identities).
- Workflow/API/billing usage roll up through the same job. Raw event tables retained 30d; rollups ≥13mo.

## Alternatives Considered
Elasticsearch/Algolia at MVP (rejected — cost + ops + residency); ClickHouse at MVP (rejected — same; accepted as V2+ candidate with explicit trigger); client-side table virtualization over full fetch (rejected — breaks at 10k and leaks data scope).

## Open Questions
Rollup granularity (hourly vs daily for drop-off at high volume) — instrument first.
