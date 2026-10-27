# Realtime — presence + patches, no CRDT at MVP

## Status
DECIDED (accepted 2026-10-28; revisit only on measured conflict data — see promotion path).

## Decision
- **Builder collaboration:** presence + field-level locks + transactional JSON-Patch save. Supabase Realtime for **presence only** (ephemeral awareness, never authoritative state).
- **Tables co-edit:** last-write-wins cell-level (`updated_at, actor` wins) + conflict toast + Realtime refresh hint (10s polling fallback).
- **Comments / status / assignment:** plain mutations + router revalidation. No socket state — low frequency, must be durable + audited.
- **Yjs / Liveblocks / CRDT: DEFERRED to V2**, only on proven need.

## Alternatives Considered
| Option | Verdict | Why |
|---|---|---|
| Yjs (self-hosted + PG persist) | DEFER | True CRDT merge, but self-host ops, auth hardening, binary-diff debugging — overkill for structured schema edits with rare contention. |
| Liveblocks | REJECT MVP | Best DX, but $/MAU, data leaves PG, lock-in. Revisit only if collaboration becomes the moat. |
| Supabase Realtime (Broadcast + Presence) | ACCEPT (presence only) | ₹0 included, no new infra, sufficient for online-list/cursors. Ephemeral, unordered — never the source of truth. |
| Custom patches (JSON Patch over REST + optimistic UI) | ACCEPT (source of truth) | Simple, auditable, RLS-compatible, transactional. Matches one-field-at-a-time builder pattern. |

## What needs realtime vs revalidation

| Surface | Mechanism | Rationale |
|---|---|---|
| Builder: who's online, field focus | Presence (ephemeral) | awareness only, loss-tolerant |
| Builder: schema edits | PATCH txn + field lock + revalidate | correctness > liveness; contention rare |
| Tables: cell edits | LWW + conflict toast + refresh hint | simple, explainable, no merge semantics |
| Tables: new submission | Realtime hint → refetch (poll fallback) | — |
| Comments/status/assign | mutation + revalidate | durable + audited, no socket |
| Public form fill | none | stateless, CDN-cacheable |

## Builder locks (MVP)
`form_locks (form_id, field_key, user_id, expires_at 30s, heartbeat 10s)`. Locked field shows avatar + name, read-only for others; steal after 60s stale with audit. Save: `PATCH /v1/forms/:id/schema {base_draft_revision, ops[]}`; `draftRevision` mismatch → 409 + fresh schema + toast. No auto-merge. (`base_draft_revision` is the Draft's optimistic-concurrency counter per VERSIONING.md — never a published version.)

## Tables conflicts
Cell write conditional on `updated_at = :base` → 0 rows = conflict → return current value + 409. Client shows "Overwritten by X — Undo / Keep mine". No silent loss.

## Consequences / Security / Performance / Cost
No CRDT/OT/Yjs at MVP; no collaborative same-input typing (comments append-only). Realtime never carries PII authority or audit duty. Presence data scoped per workspace/form, never cross-tenant. Cost ₹0.

## Migration
Add Yjs ONLY if: >30% of teams co-edit weekly AND lock-conflict rate >5% AND churn attributed. Then Yjs for schema JSON only; locks + PG remain authority, snapshot persisted on save.

## Open Questions
Lock-UX tuning (steal timeout) from Phase 3 usage data.
