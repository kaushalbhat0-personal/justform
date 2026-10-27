# ADR-009 — Answer Storage: Hybrid JSONB + Materialized Index

## Status
DECIDED (accepted 2026-10-28; Spike 4 bounded confirmation at 100k-scale before Phase 6).

## Context
Submission answers must scale 1k → 1M+ per form with filtering/sorting/export/analytics, survive schema evolution (rename/delete), and keep file fields, calcs, and API stability sane — on Postgres + RLS.

## Decision
**Model C Hybrid:** `submissions.answers JSONB` (canonical, keyed by stable field `id`) + materialized side index for filterable/sortable fields (explicit opt-in per field, capped count) + attachments as relational rows. Files never in JSONB — refs only.

## Alternatives Considered
- **A) answers-JSONB only.** Simplest writes, zero migration on schema change, fine at 1k–10k (GIN helps `contains`). Fails at 100k–1M for range/sort/join and makes analytics painful. **Rejected as sole model.**
- **B) Per-field rows (EAV: one row per answer).** Normalized and per-field-indexable, but write amplification (50 fields = 50 rows; 1M subs → 50M rows), pivot-heavy reads, storage + RLS overhead, awkward files/repeaters/calcs. **Rejected** — unjustified unless field-level RLS is needed, which it is not (redaction happens in RPC/views).

## Why
| Concern | A JSONB | B EAV | C Hybrid (chosen) |
|---|---|---|---|
| 1k/10k subs | excellent | ok (amplified) | excellent |
| 100k/1M + filter/sort | poor | ok, huge rows | good (indexed side table) |
| Reporting/export/analytics | awkward | pivot-heavy | JSONB→warehouse + live filters on index |
| Indexing | GIN on answers | b-tree per row | GIN + b-tree `(form_id, field_id, typed val)` |
| Write amp / storage | 1 row | N rows (10–50×) | 1 row + ≤cap index rows |
| Schema evolution | trivial (by `id`) | migration-heavy | trivial; index rebuilt async on publish |
| File fields | blob risk | FK natural | relational rows + signed URLs (best) |
| Calc / API | recompute on read / stable | recompute per row / churny | stored computed + deps; stable `id`-keyed API |

Builder marks sortable/filterable fields (cap enforced, default 8–12/form — Spike 4 tunes); publish triggers idempotent resumable index backfill. Field delete → answers kept (tombstone), index rows soft-deleted. Key rename → alias map, `id` unchanged. Full-text via tsvector side column later, out of MVP.

## Consequences
Analytics/exports read the JSONB snapshot + version schema, never the live Draft. Index backfill worker required (online, version-pinned).

## Security Impact
RLS on `submissions(form_id, workspace)`; index/attachments inherit via `submission_id` FK; file serving via short-TTL signed URLs minted after grant check.

## Performance Impact
GIN on `answers`; b-tree on index table; partition `submissions` by form-hash beyond ~1M rows/partition. See SPIKES.md Spike 4 for acceptance thresholds.

## Cost Impact
~1 row per submission + small fan-out vs 10–50× EAV row explosion — directly lowers storage + IOPS at scale.

## Migration/Reversal Strategy
Start JSONB+GIN only; add the side-index table when a form passes 10k subs or opts into filters. Backfill is online and reversible (index is derived — droppable and rebuildable).

## Open Questions
Exact indexed-field cap (8 vs 12) — instrument then tune.
