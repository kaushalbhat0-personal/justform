# FORMOS — Phase 0 implementation

Production repository foundation for the FORMOS modular monolith (frozen architecture:
`docs/arch/FORMOS-ARCH-001.md`, `FORMOS-ARCH-FIX-001.md`, `FORMOS-ARCH-FIX-002.md`).

## Layout (source-of-truth locations)

```text
apps/web/               Next.js App Router (arrives Phase 1; placeholder + contract now)
packages/domain/        canonical domain logic: errors, roles, permissions, audit events
packages/config/        environment contract + validation (zod), logging foundations
packages/database/      ONLY database access: supabase/ migrations, RLS, typed queries, tests
packages/ui/            design tokens only (no components in Phase 0)
packages/forms-engine/  BOUNDARY RESERVED — canonical FORMOS schema lives here (Phase 2+)
workers/                BOUNDARY RESERVED — scheduled-tick handlers (Phase 8)
supabase/               migration source of truth (applied via Supabase CLI / db push)
scripts/guards/         CI architecture guards (RLS, search_path, secret hygiene)
docs/                   recon/, arch/ (frozen), implementation/ (this phase)
```

Rules: no `utils/`/`shared/`/`common` catch-alls — code lives in its owning domain.
`packages/database` is the only package that touches the DB. No browser code imports
server secrets (enforced by `scripts/guards`).

## Commands

```text
npm install          install workspaces
npm run typecheck    strict TS across packages
npm run lint         eslint (boundaries + hygiene)
npm run guards       architecture guards (RLS policies, DEFINER search_path, secret scan)
npm run test         vitest (unit + PGlite-backed RLS/security integration)
npm run ci           typecheck + lint + guards + test
```

Integration tests run against in-process PGlite (real Postgres semantics: RLS,
SECURITY DEFINER, triggers) — no external DB required, ₹0 CI.

## Phase 0 delivers

Repo + conventions + env contract + migration foundation + S3 RLS spike (proven by
automated tests) + authorization primitives + append-only audit foundation + error/
observability foundation + CI gates + design tokens. See
`docs/implementation/PHASE-0.md`. Product features (builder, renderer, submissions,
workflows, payments, AI, …) are explicitly NOT in this phase.
