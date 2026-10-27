# FORMOS-IMPL-002 — Phase 1 report (identity, workspace, RBAC, invitations, audit)

**Status:** implementation complete; live-project verification runnable but not yet executed (no Supabase project credentials in this environment — see §2). **Date:** 2026-10-28.

## 1. What was implemented
- **`@formos/auth` (new):** the ONE canonical identity boundary — `SessionUser`, `AuthClientLike` (injected client, no Next.js import in the package), `getSessionUser`, `signOutEverywhere`, email normalization/matching for invitation binding. 2 unit tests. Application code must not import Supabase Auth APIs directly.
- **`apps/web` (new Next.js 16 + React 19 App Router):** middleware session refresh + `/app` protection; `/` landing; `/login` (email/password via browser anon-key client, error states); `/app` (workspace list + creation); `/app/[ws]` (role badge, member table with admin/viewer + remove, invite panel with one-time link display, audit list for admins, uniform `notFound()` on non-membership = URL-as-locator); `/app/invite/[token]` (accept flow); `app/app/error.tsx` (user-safe errors). All mutations are `"use server"` actions in `lib/workspaces.ts` (`createWorkspace`, `setRole`, `removeMember`, `invite` with SHA-256-hashed token, `accept`, `ensureProfile`); reads go through `lib/identity.ts` (`requireUser`, `getMembership`, `listMyMemberships`) which re-checks membership server-side and mirrors `can()` from `@formos/domain` (single evaluator — no second permission system).
- **Database migration `0003_phase1_identity.sql`:** profile self-INSERT policy; `formos.accept_invitation` (hash match, expiry, single-use via `used_at`, JWT-email binding, already-member guard); `formos.remove_member` (admin+, no self-removal, owner-transfer protection); all pinned-`search_path` DEFINER, deny-by-default RLS preserved.
- **Audit wiring:** `workspace.created`, `member.invited`, `member.invite_accepted`, `member.role_changed`, `member.removed` via `lib/audit.ts` (RLS INSERT, admin read).
- **Design:** tokens-only styling (`globals.css` → `tokens.css`), `touch-target` inputs, visible focus, reduced-motion, responsive tables-to-cards <720px, WCAG 2.2 AA posture carried from DESIGN-SYSTEM.md.
- **Guards extended:** G4 skips build output (`.next/`); G3 now covers 9 DEFINER functions.

## 2. Real Supabase verification
- **Local stack: BLOCKED — Docker engine is not installed** in this environment (CLI present, daemon absent; `supabase start` refuses without Docker Desktop). No system software was installed unilaterally.
- **PGlite regression (done, green):** migrations 0001–0003 apply in order; 18 database tests pass (11 S3 + 5 invitation/removal/profile + 2 ids), proving RLS, RPC validation paths, expiry/replay/email-mismatch denials, and immutability under real Postgres semantics.
- **Live runbook (ready, one command):** `scripts/verify/supabase-live.mjs` — signup/login/session/logout/invalid-session, workspace create, member/non-member/anon/cross-workspace denials, role-escalation denial, invite create/accept/replay-expiry denial, audit writes, RPC hardening probe. Requires: `supabase link`, `supabase db push`, then the three env vars. **Gate A (migrations push) and the live portions of Gates B–F are PENDING a project with credentials — this is the single remaining item and it requires no code changes.**
- E2E: no runner installed (deliberate — Playwright deferred); manual smoke runbook in PHASE-1.md (`login → shell → workspace → create → invite → accept → role visible → logout`).

## 3. Gates
- A (migrations): SQL proven via PGlite apply-order; `db push` pending project. **PARTIAL.**
- B (auth): flows implemented + unit-tested; live runbook ready. **Code PASS, live PENDING.**
- C (isolation): PGlite-verified (member/non-member/cross-ws/anon/URL-swap shape). **Code PASS, live PENDING.**
- D (RBAC): domain matrix (15 tests) + PGlite RPC enforcement + UI gating. **Code PASS, live PENDING.**
- E (invitations): token/hash/expiry/single-use/email-bind proven in PGlite (5 tests); UI one-time display; never logged. **Code PASS, live PENDING.**
- F (security): no service-role in request path (G4 + code review: service key appears nowhere in apps/packages), browser trees clean, RLS ACTIVE per migration, DEFINER pinned (G3). **PASS.**
- G (CI): `npm run ci` green — typecheck, lint, guards, 44 tests, `next build`. **PASS.**

## 4. Dependencies added (+ justification, all Phase-1-necessary)
`next`, `react`, `react-dom` (App Router shell); `@supabase/ssr` + `@supabase/supabase-js` (Auth + RLS-enforcing data access); `server-only` (boundary enforcement); `@types/react`, `@types/react-dom` (build). NOT installed (per fence): RJSF, RHF, form/query builders, workflow/payment/AI/PDF/sign/Redis/Kafka/ES SDKs.

## 5. Security notes
Invitation raw tokens exist only in the inviter's response + DB hash; uniform RPC errors prevent user enumeration; logout destroys usable session state (middleware revalidates per request); `workspace_id` from URL is locator-only (membership re-lookup + RLS + uniform 404); audit diffs carry emails/roles only, never tokens.

## 6. Known issues
`@formos/auth` has no Next.js coupling by design — `apps/web` owns the `next/headers` cookie wiring. `MemberTable` exposes quick admin/viewer toggles only (full matrix in actions, UI extended later). Magic-link/SSO deferred per architecture.

## 7. Next
`FORMOS-IMPL-003` (Phase 2) may start app/identity work in parallel with live verification, but **form-engine spikes S1/S2 gate any form-schema code**, and the live runbook should be executed against a real project before Phase 2 closes.
