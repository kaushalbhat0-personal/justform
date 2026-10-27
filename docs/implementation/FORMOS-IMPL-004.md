# FORMOS-IMPL-004 — Phase 4: Production Canonical Form Engine + Persistence/Versioning

## Scope

First production persistence/versioning layer for the proven canonical schema.
NOT the builder, submissions, public URLs, or any later module.

## Model (migration 0005)

```text
Workspace
   └── forms (identity + mutable draft: draft_payload JSONB, draft_revision OCC)
          └── form_versions (immutable snapshots: version no, snapshot, hash, publisher, timestamp)
```

- No `form_drafts` table (draft lives on the row); no `form_publications` (public URLs deferred).
- `key` UNIQUE per workspace; `status` active|archived (unpublish = archive, documented).
- Canonical validation/migration/hash run server-side (TypeScript) before every
  write; the database owns tenancy, roles, numbering, and immutability.
- Publish authorization rides on the existing `form`/`update` grant (builder
  floor) — no new domain permission. Only addition: `form.deleted` audit event.

## Concurrency

- `draft_revision` starts at 1; server UPDATEs with `WHERE revision = expected`,
  increments owned by the database; zero rows → `conflict` (409) with current
  revision; client state never destroyed.
- `publish_form` RPC row-locks the form (serializes concurrent publishers),
  re-checks expected revision, mints `max+1` (UNIQUE backstop).

## Publishing

- Atomic RPC: verify auth/member/builder+ → lock → revision check → insert
  self-contained snapshot → return version number.
- Rollback = republish: snapshot → draft (OCC) → publish as next version.
- Hash = sha256 over key-sorted canonical JSON (engine `hashCanonical`);
  verified live: same doc → same hash, snapshot round-trips exactly.

## Database protection

- RLS FORCE on both tables; forms: member-read, builder+ insert/update/delete;
  versions: member-read only (no DML policies, no direct DML grants).
- `form_versions_immutable` trigger blocks UPDATE/DELETE for every role
  (incl. table owners); verified live and in PGlite at all layers.
- Wrappers: `public.publish_form` → `formos.publish_form` (same 0004 pattern).

## Verification

- PGlite: `packages/database/tests/forms.test.ts` (12 tests: OCC, roles,
  cross-workspace, numbering, immutability, slug scoping, audit).
- Live: `supabase db push` (0005 applied) + `scripts/verify/forms-live.mjs`
  (12/12 gates PASS; [S] draft insert ~259ms, OCC update ~278ms,
  publish ~265ms, version read ~258ms — network-bound, same region).
- Live catalog inspection: RLS/force, exact policy set, DEFINER + pinned
  search_path + least-privilege EXECUTE, triggers enabled, constraints present.
- CI green (exit 0): typecheck, eslint, guards G1–G7, 97+12 tests, Next build.

## Deferred

Builder, property editing, templates, publish UI polish, public form URLs,
submissions/inbox, and all later modules remain untouched.
