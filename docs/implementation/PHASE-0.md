# PHASE-0 — what exists, what it proves, what comes next

## Exists
```text
package.json (workspaces) · tsconfig.base.json · eslint.config.mjs · .prettierrc
.env.example (classified contract) · .gitignore · README.md
.github/workflows/ci.yml
apps/web/README.md                      contract for the Phase-1 Next.js app
workers/README.md                       contract for Phase-8 tick handlers
packages/domain/    errors, authorization, audit + 15 unit tests
packages/config/    env validation, logging + 7 unit tests
packages/database/  supabase migrations (0001/0002), PGlite harness + 11 S3 tests
packages/ui/        tokens.ts + tokens.css (no components)
packages/forms-engine/  boundary README (no code until Phase 2)
scripts/guards/architecture-guards.mjs   G1–G5 CI gates
supabase/migrations/   migration source of truth
docs/implementation/FORMOS-IMPL-001.md   phase report
```

## Proves
Typecheck + lint + guards + 33 tests green on `npm run ci`. S3 PASS: RLS isolation,
role enforcement, RPC-only control plane, immutable tenancy, append-only audit —
against real Postgres semantics under a least-privilege role, with zero external services.

## Conventions established
Strict TS (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, no unused);
domain owns logic (`@formos/domain` is the only permission evaluator);
database owns storage (`@formos/database` is the only DB toucher);
config owns env/secrets classification; browser trees import only the public env
subset + tokens (guard-enforced); migrations follow 0001 conventions
(portable SQL, pinned DEFINER, deny-by-default RLS, Rule-1/2/3 tenancy).

## Next
NEXT: FORMOS-IMPL-002 (Phase 1: identity/workspace/RBAC app + Supabase push verification).
Do not start builder/renderer/submissions until Phases 2–6 with their gating spikes (S1/S2/S4/S5/S6).
