# ADR-006 — Multi-Tenancy Model

## Status
DECIDED (accepted 2026-10-28).

## Context
Greenfield Jotform competitor: Next.js modular monolith, Postgres + RLS, Supabase Auth. Must guarantee tenant isolation from day one at ~₹0 cost, with a future self-host + data-residency path and no rewrite.

## Decision
1. **Single Postgres database; `workspace` = tenant boundary.** Every tenant-owned row carries non-nullable `workspace_id`.
2. **RLS deny-by-default** on all tenant tables. No policy = no access.
3. **Tenant identity ONLY from server-verified session** (`auth.uid()` → membership lookup in RLS/secure RPC). Never trust client-supplied `workspace_id`, headers, or query params.
4. **Service-role / RLS bypass confined** to background workers and allowlisted SECURITY DEFINER RPCs. Never in browser, never in general API routes.
5. **Stage 0: Supabase-hosted Postgres with portable SQL only** — no proprietary extensions in the tenancy/authz path. Exit path: plain Postgres + self-hosted auth without touching RLS.
6. **Residency later = per-region database** (router + logical migrate). Explicitly not schema-per-tenant, not DB-per-tenant now.
7. **`workspace_id` is IMMUTABLE on every row that carries it.** No UPDATE of `workspace_id` is permitted by any role/RPC (enforced by trigger + RLS `WITH CHECK`). Cross-workspace "move" of a form/table = clone operation (new ids, new `workspace_id`), never a re-parent. This immutability is what makes parent-join RLS sound for the child tables listed in DATABASE-MODEL.
8. **Public intake is RPC-only.** No anonymous direct INSERT exists on any table; the scoped intake function (SUBMISSION-PIPELINE.md) is the sole anonymous write path.

## Alternatives Considered
- **Schema-per-tenant:** rejected — N×DDL migration fan-out, pool fragmentation, painful cross-workspace analytics/audit/backups. No benefit at our scale.
- **DB-per-tenant now:** rejected — kills ₹0 start (cost per DB), multiplies ops/migrations/backups, breaks free-tier onboarding. Revisited only via per-region DB for Enterprise residency.
- **App-level filtering without RLS:** rejected — one missed `WHERE` = breach. RLS is storage-layer defense-in-depth.
- **Proprietary-extension tenancy (Vault/pg_net in hot path):** rejected for core — Postgres-native only.

## Why
One migration set, one pooler, one backup story (cheapest, fastest to MVP). RLS gives a uniform guarantee across REST, RPC, workers, and ad-hoc SQL. `workspace_id` everywhere makes ownership, export, deletion (DSR), and metering trivial. Portable SQL preserves the self-host option with zero tenancy rewrite.

## Consequences
All queries workspace-scoped; `workspace_id` in PKs/indexes of hot tables. Joins must re-assert `workspace_id` equality (composite FKs — no cross-workspace linkage). Public intake has NO table policy — it runs exclusively through the hardened intake RPC. Worker code follows a separate audited service-role path with tests.

## Security Impact
`ENABLE ROW LEVEL SECURITY` + revoke broad grants from `anon`/`authenticated`; session→membership resolved server-side per request (cache ≤60s, invalidate on role change/removal); service-role keys live only in worker env/vault with rotation and per-env separation; signed URLs and webhooks re-check membership at generation time.

## Performance Impact
Composite indexes `(workspace_id, created_at)` / `(workspace_id, id)`; `STABLE` helper `is_member(wid)` to avoid per-row membership subquery storms; PgBouncer (transaction mode) from start; time-partition `submissions`/`audit_log`/`webhook_deliveries` past ~10M rows.

## Cost Impact
Single free/low-tier project at Stage 0; no per-tenant infra. Self-host path: single-node Postgres + replica; no license cost.

## Migration/Reversal Strategy
Nightly CI check: `pg_dump --schema-only` must apply to stock Postgres 16. Auth behind an `AuthProvider` interface (Supabase = impl #1). Region pinning later: add `region` on workspaces, route by region, migrate a workspace via logical dump/restore + ID freeze.

## Open Questions
Super-admin break-glass access (default: none at MVP — dual-audit RPC if ever added); sub-workspaces/client portals (grants-only vs nested tenancy — post-MVP); per-region storage buckets.
