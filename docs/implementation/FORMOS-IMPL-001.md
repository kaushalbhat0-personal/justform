# FORMOS-IMPL-001 — Phase 0 report (production foundation + S3 security gate)

**Status:** PASS · **Date:** 2026-10-28 · **Scope:** Phase 0 only (repo + conventions + env + DB foundation + S3 spike + CI).

## 1. Repository audit (pre-implementation)
`docs/` only (`recon/FORMOS-RECON-001.md`, 33 frozen `arch/*.md`); no package.json, source, env, CI, Supabase config, tests, or git repo. Node v24.11.1, npm 11.6.2, git 2.42. Confirmed greenfield — foundation established cleanly, no deviations to reconcile. Git initialized in this phase.

## 2. What was implemented
- **Structure:** npm workspaces (`packages/*`); `apps/web` + `workers/` as contract READMEs (no code until Phases 1/8); `packages/forms-engine` as a reserved boundary (no schema code until Phase 2 — satisfies the no-competing-schemas rule by fixing the location now).
- **`@formos/domain`:** canonical `DomainError` (safe public envelope, secret-stripping serialization), 5-role + grant + assignment `can()` evaluator mirroring ADR-007, invite rule, audit event catalogue. Pure TS, 15 unit tests.
- **`@formos/config`:** zod-validated env contract (public/server/secret classification, `publicEnv()` browser-safe narrowing, `requireSecrets` boot gate), JSON-line logger with key redaction. 7 unit tests.
- **`@formos/database`:** `supabase/migrations/{0001_foundation,0002_tenancy_s3}.sql` — conventions (portable SQL, zero extensions, fixed-`search_path` DEFINER helpers, immutable-`workspace_id` trigger, composite discipline, RLS deny-by-default + FORCE); tables `profiles, workspaces, memberships, invitations (RLS only), resource_grants (RPC-minted only), audit_log (append-only)`; RPCs `create_workspace, set_role, create_grant, revoke_grant` (+ `is_member/my_role/role_rank` helpers).
- **S3 proof:** PGlite-backed integration suite (real Postgres semantics: RLS, DEFINER, triggers) under a least-privilege role — 11 tests, all passing (see §4).
- **`@formos/ui`:** tokens only (`tokens.ts` + `tokens.css` mirror, reduced-motion guard) — no components.
- **Guards:** `scripts/guards/architecture-guards.mjs` — G1 RLS+FORCE per tenant table, G2 DML-grant/policy pairing, G3 DEFINER `search_path` pinning, G4 browser-tree secret scan, G5 extension ban. CI: typecheck + eslint + guards + vitest (`.github/workflows/ci.yml`).

## 3. Architecture compliance
No deviations. Terminology follows FIX-001/FIX-002 (`publishedVersion`/`draftRevision` not yet needed — no form tables in Phase 0 by design). Spend decisions (Razorpay, pg-boss, ClamAV host) untouched — dead interfaces only, per fence.

## 4. Security evidence (S3 — all PASS, PGlite + `app_user` non-superuser role)
member isolation ✓ · non-member reads empty ✓ · cross-workspace read (incl. known-id URL-swap shape) empty ✓ · cross-workspace UPDATE silent-deny (0 rows), DELETE privilege-deny ✓ · `workspace_id` immutable (trigger proven via privileged writer; RLS denies app roles first) ✓ · deny-by-default (no direct membership/grant INSERT; UPDATE without policy) ✓ · role floor (viewer rename → 0 rows) ✓ · `set_role` (no self-target, no at-or-above-rank, admin-only) ✓ · grants RPC-only + validation (admin mint, viewer denied, non-member grantee denied, expiry enforced, revoke) ✓ · audit append-only (insert ok, update/delete denied, stranger reads empty) ✓ · invitations admin-scoped + unauthenticated creation blocked ✓ · anon `auth.uid()`-null reads empty ✓. Static: G1–G5 guards green; TESTING.md matrix extended (grants table, `workspace_id` UPDATE, URL-swap uniform-404).

## 5. S3 result
**PASS** — member isolation, workspace isolation, role enforcement, immutable ownership, deny-by-default all demonstrated by automated tests. No service-role in any user path (tests run as `app_user`; migrations grant nothing to `service_role`; G4 scans browser trees).

## 6. Dependencies (all justified, ₹0, no lock-in)
`typescript, vitest, zod` (env/validation foundation), `@electric-sql/pglite` (dev-only, real-PG test DB — keeps CI external-service-free), `eslint, typescript-eslint, globals, prettier` (gates), `@types/node` (types). NOT installed: Next.js/React (Phase 1), RJSF/RHF (Phase 2), Supabase JS (Phase 1), any workflow/queue/payment/AI/PDF/sign SDKs — each deferred to its phase per dependency policy.

## 7. Known limitations
PGlite shims (`anon`/`authenticated` roles, `auth.uid()` stub, `GRANT authenticated TO app_user`) are test-only and never ship in migrations — first Supabase-CLI `db push` in Phase 1 must be verified against a real project. `role_rank` is a plain (non-DEFINER) helper — safe (no table access). Invitation accept flow is table+RLS only; token-verify RPC arrives with Phase 1 identity work.

## 8. Intentionally deferred (explicit)
Builder, renderer, rules engine, publishing, submissions, inbox, tables, workflows, payments/billing money-movement, signatures, PDF, apps/portals, marketplace, AI, deep integrations, SSO, custom domains, residency, multi-currency, full domain model, E2E beyond the smoke framework. `apps/web`, `workers/`, `forms-engine` contain boundary declarations only.

## 9. Next phase prerequisites
Phase 1 needs: Supabase project (or self-host decision per ADR-006 exit path), `supabase db push` verification of 0001/0002, Next.js + `@formos/auth` behind the provider interface. Gate: none open — S3 PASS, CI green.
