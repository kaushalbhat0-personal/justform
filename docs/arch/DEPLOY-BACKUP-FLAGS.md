# Deployment, Backup/DR & Feature Flags

## Stage 0 — ₹0 (MVP build + private beta)
Vercel free (Next.js) + Supabase free (PG + Auth + storage) + Resend free (3k/mo) + Sentry free + scheduled bounded outbox tick (platform cron → internal `/api/internal/outbox-tick`, cron-secret + advisory-lock single-flight, N=100 / 50s cap — QUEUE-WORKERS.md). No persistent worker process anywhere at Stage 0. Limits that force exit: Supabase free caps, tick dispatch lag >10s p95, storage >80%, email >2.5k/mo.

## Stage 1 — first paying customers
Paid Vercel/Supabase tiers (PITR enabled), pg-boss promotion per QUEUE-WORKERS triggers, ClamAV worker host, commercial AV/scan evaluated, custom domains, status page. Backups: daily encrypted dump + PITR; restore drill monthly.

## Stage 2 — 10k+ workspaces
Read replica (tables/analytics), object-storage CDN, edge-cached renderer, queue service if triggers hit, per-workspace throttle tuning, cost-per-workspace dashboarding.

## Stage 3 — enterprise
Region pinning (per-region DB + bucket; router by `workspaces.region`), SIEM/audit export, DPA/BAA posture + pen-test reports, white-label app/host, SSO/SAML/SCIM, CSM runbooks. Migration path is explicit from Stage 0 (portable SQL, `AuthProvider` interface, `region` column reserved) — no rewrite.

Never over-engineer Stage 3 today; but every Stage 0 choice must keep its migration path open (documented per ADR).

## Backup & disaster recovery (MVP targets)
- **DB:** daily encrypted dumps + PITR (enabled Stage 1; free-tier logical dumps + tested restore at Stage 0). **RPO ≤24h / RTO ≤4h aspirational on free tier; tighten to RPO ≤1h / RTO ≤1h at Stage 1.**
- **Object storage:** versioned buckets + cross-region copy at Stage 2; per-workspace prefix makes targeted restore possible.
- **Audit log:** never purged except by retention job; retained ≥1yr (cold storage); durability = compliance posture.
- **Procedures:** restore runbook (DB PITR → verify RLS policies → replay outbox → verify counters); region failure = DNS + read-replica promote (Stage 2+); accidental delete = soft-delete 30d window first; tenant delete = Owner-confirmed, 30d recoverable, then hard purge; corruption = stop writes, PITR to last-known-good, replay ledger.
- **Drill:** full restore rehearsal before Phase 11 exit; results recorded.

## Feature flags (gating visibility — NEVER authorization)
Scopes: workspace-level, plan-level, internal-beta, kill-switch, migration. RULE: flags gate UI/routes visibility; RLS + `can()` grants gate access — a flag can never substitute for an authorization check (a flagged-on route with no grant still denies; a flagged-off route with a grant still denies at the flag layer but the grant is untouched). Unfinished modules (workflows/payments/sign/pdf/apps/ai) ship flagged-off with reserved names so integration happens without exposure.
