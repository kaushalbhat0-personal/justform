# PHASE-1 — identity, workspace, RBAC, invitations (done, live-project verification pending)

## Exists
`@formos/auth` (canonical identity) · `apps/web` (login, authed shell, workspaces, members, invites, audit) · migration `0003_phase1_identity.sql` · `scripts/verify/supabase-live.mjs` (live gate runner) · 44 tests green · `next build` green.

## Proves (locally)
Unit: auth boundary, roles/grants/invites logic, tokens, env, logging, ids. Integration (PGlite, least-privilege role): S3 isolation suite + invitation lifecycle (create/accept/replay/expiry/email-mismatch) + owner/admin/builder/viewer enforcement + self-escalation denial + append-only audit. Guards: RLS+FORCE everywhere, DML-policy pairing, DEFINER pinning ×9, browser secret scan, zero extensions.

## Live verification runbook (pending credentials)
```text
supabase link --project-ref <ref>   # needs access token, once
supabase db push                    # applies 0001–0003 (Gate A)
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/verify/supabase-live.mjs
# Gates B–F server subset. Then manual smoke:
# login → shell → workspace → create → invite (copy link) → accept as second user → role visible → logout
```
No code changes expected; the script exits non-zero with the failing gate named.

## Conventions locked
One auth import path (`@formos/auth`); one permission evaluator (`@formos/domain`); one DB toucher (`@formos/database` + migrations); server actions as the single mutation boundary (no parallel API-route/service/controller layers); URL workspace ids are locators; uniform 404s; raw invitation tokens never stored/logged.

## Next
NEXT: FORMOS-IMPL-003 (Phase 2: S1/S2 spikes → canonical schema + derivations; no builder UI until spikes pass). Do not start submissions/inbox/tables/workflows/payments/AI.
