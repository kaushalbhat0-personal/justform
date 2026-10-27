# FORMOS-ARCH-FIX-001 — Reconciliation & Implementation Gate

**Date:** 2026-10-28 · **Scope:** reconciliation only — no redesign, no new services, no implementation. Skills/MCP: `read`/`grep` (full arch-artifact audit), `webfetch` (authoritative RJSF v6.11.0 docs — validation + form-props — used to resolve the RJSF/AJV/Zod ambiguity with evidence instead of assumption). No other tools were material; browser/REA/design-system skills intentionally unused (nothing to inspect, no components in this phase).

## 1. Review verdict
**PASS WITH REQUIRED FIXES** — all fixes below are applied in this same phase. No BLOCKED items remain.

## 2. Issues found
| ID | Sev | Issue | Resolution | Files changed |
|---|---|---|---|---|
| F-01 | P0 | Billing contradiction: checkout/subscriptions appeared in MVP while MVP-FENCE said payments OUT | MVP = plans/entitlements/counters/ledger/quotas/usage-screen/CTA + dead `BillingProvider` port; all money movement → V1 gated by billing-terms review | METERING-BILLING.md, MVP-FENCE.md, BUILD-ORDER.md (Ph9, V1 gate), ADR-INDEX.md (ADR-020), MODULE-BOUNDARIES.md, FORMOS-ARCH-001.md |
| F-02 | P0 | Stage 0 assumed an indefinite worker process on serverless | Canonical: scheduled bounded outbox tick (platform cron → authed internal route, N=100/50s, advisory-lock single-flight, lease-safe claims, per-pool fairness); options B/C/D rejected with reasons | QUEUE-WORKERS.md, EVENTS-ASYNC.md, SYSTEM-ARCHITECTURE.md, DEPLOY-BACKUP-FLAGS.md, MONOREPO.md, BUILD-ORDER.md (Ph8) |
| F-03 | P0 | Anon `INSERT submissions` capability implied by "intake policy" language | Intake is RPC-only: zero anon table grants; hardened SECURITY DEFINER function (fixed search_path, publication-verified, workspace-from-publication, in-txn caps/schedule/unique/idempotency, no SELECT-back) | SUBMISSION-PIPELINE.md, RLS-THREAT-MODEL.md (T6, tests 6/11/12), ADR-006, ADR-007 (matrix), DATABASE-MODEL.md, API-WEBHOOKS.md |
| F-04 | P0 | Child tables relied on parent relationships without explicit tenancy rule | Rule 1 explicit `workspace_id` on all first-class tables; Rule 2 names exactly 6 inheritors with 4-part soundness proof; Rule 3 `workspace_id` IMMUTABLE (move = clone); Rule 4 RPC/worker-only writes | DATABASE-MODEL.md (v1), ADR-006, RLS-THREAT-MODEL.md, TESTING.md |
| F-05 | P0 | RJSF + AJV + Zod responsibilities ambiguous ("AJV-free Zod-only" unproven) | Verified vs RJSF v6.11.0 docs [CONFIRMED]: stub `ValidatorType` (no AJV import, bundle-scanned) + `noValidate` + `extraErrors`/`extraErrorsBlockSubmit`; derived schema restricted to non-validator-dependent constructs; AJV excluded from prod; Zod sole authority client+server from same generator | ADR-003, FIELDS.md (new), SPIKES.md (S1 rewritten with 5 acceptance criteria), TESTING.md (AJV-absence gate), ADR-INDEX.md |
| F-06 | P1 | "15 MVP field types" not canonically defined anywhere | MVP = **12 types** with per-type contracts (value shape, validation, JSON Schema, Zod, widget, a11y, server-safe, storage); V1/V2 lists; all references updated | FIELDS.md (new), FORM-SCHEMA.md, MONOREPO.md, BUILD-ORDER.md, MVP-FENCE.md |
| F-07 | P1 | `version_no` used for 3+ concepts | Four terms: `schemaVersion` / `draftRevision` (OCC, mutable) / `publishedVersion` (immutable) / `rendererVersion`; bare `version_no` banned | VERSIONING.md (rewritten), FORM-SCHEMA.md, REALTIME.md, DATABASE-MODEL.md, SUBMISSION-PIPELINE.md |
| F-08 | P1 | URL `:ws_id` vs session-derived tenancy ambiguous | URL is a locator, never an authority: session membership / key binding re-checked, resources re-resolved under workspace, uniform 404 on mismatch, binding immutable | API-WEBHOOKS.md, RLS-THREAT-MODEL.md (test 8), TESTING.md |
| F-09 | P1 | Polymorphic `resource_grants` unenforceable by FK | Grants RPC-minted only (existence + same-workspace + not-deleted + action-subset + member checks, uniform non-oracle errors) + orphan sweep + read-scoped RLS | ADR-007, DATABASE-MODEL.md, RLS-THREAT-MODEL.md, TESTING.md |
| F-10 | P1 | Spike→phase gating implicit | Normative gate chain `0→S3→1→S1/S2→2/3→S8→7→S5→5→S4/S6→6→S7/S9→8→S10→9→10/11` in SPIKES.md; phase PRE lines carry gates; phase EXIT unclaimable with open gates | SPIKES.md, BUILD-ORDER.md |
| F-11 | P1 | MVP scope lists drifting (billing/checkout, counts) | Canonical MVP/OUT lists re-asserted (metering IN, payment collection OUT); IN/OUT/extension-points consistent across fence, build order, modules | MVP-FENCE.md, BUILD-ORDER.md, MODULE-BOUNDARIES.md |
| F-12 | P2 | Performance numbers presented without status | Labels introduced: [T] target, [S] spike criterion, [SLO] launch SLO; nothing called "validated" until measured | RENDERER-EMBED.md, TESTING.md, SPIKES.md, BUILD-ORDER.md |

## 3. Canonical architecture after reconciliation
Modular monolith (one deployable): Next.js App Router + React + TS; canonical FORMOS schema (MVP-12, FIELDS.md) → derived JSON Schema/uiSchema + generated Zod; RJSF renders with validation bypassed (stub validator + `noValidate` + blocking `extraErrors`), Zod is sole validation authority; immutable `publishedVersion`s with `draftRevision` OCC; workspace tenancy (single PG, RLS deny-default, immutable `workspace_id`, RPC-minted grants); RPC-only anonymous intake; scheduled bounded outbox tick (no persistent process); PG-first search/tables/analytics; quarantine file pipeline; iframe embed with labeled budgets; REST v1 + signed webhooks; metering without money (dead billing port); flagged-off V1/V2/V3 (workflows, checkout/subscriptions, payments-in-forms, sign, PDF, apps, AI, SSO, residency).

## 4. MVP truth table
| Capability | MVP | V1 | V2+ |
|---|---|---|---|
| Auth, workspace, 5 roles + grants, audit | ✅ | — | custom roles (data) |
| Canonical schema MVP-12, derivations, rules/calc v1 + test mode | ✅ | V1 types (address/signature/matrix/…) | payment, x-* promotions |
| draftRevision OCC, immutable publishedVersions, rollback=republish | ✅ | — | — |
| Builder (locks, undo, autosave) | ✅ (S1/S2/S8 gated) | — | — |
| Renderer + <5KB loader iframe embed | ✅ (S5 gated) | custom domains | JS-embed (fresh ADR) |
| RPC-only submission intake, idempotency, quarantine | ✅ (S4/S6 gated) | — | — |
| Inbox + assignee/SLA/status/comments | ✅ | — | — |
| Tables v1 + async CSV export | ✅ | Excel/PDF, scheduled reports | 1M+ replica path |
| REST v1 + keys/scopes/quotas/OpenAPI + signed webhooks | ✅ (S7/S9 gated) | OAuth, MCP | marketplace |
| Metering (counters/ledger/quotas/usage screen/CTA), dead billing port | ✅ (S10 gated) | live Razorpay/Stripe checkout, subscriptions, invoices, refunds, top-ups | multi-currency |
| Quarantine file pipeline + ClamAV path | ✅ (S6 gated) | commercial scan | — |
| Workflow engine, payment collection, e-sign, PDF/Smart-import, apps/portals, AI, deep CRM sync, SSO, residency | ❌ | checkout/billing; workflows; SSO; payments-in-forms | sign (counsel), PDF, AI (DPA), residency |

## 5. Security boundary summary
**Browser (anon)** → redacted publication metadata (read-only RPC) + intake RPC invocation only (write-only, receipt-only); zero table grants. **Browser (authed)** → session cookie → server membership load → `can()` + grant check → RLS; URL `:ws_id` is a locator re-validated at every layer. **API keys** → single-workspace binding (immutable), scope ⊆ creator perms, mismatch → uniform 404. **RLS** → deny-default on all tenant tables; membership/grant RPCs are the only writers for sensitive rows; `workspace_id` immutable by trigger. **Intake RPC** → SECURITY DEFINER, locked-down owner, fixed `search_path`, strict params, publication-verified, workspace-from-publication, in-txn enforcement, no SELECT-back. **Workers/tick** → cron-secret tick + service-role handlers with `workspace_id`-pinned payloads + audit; never accept caller scope.

## 6. Worker execution model (Stage 0 canonical)
Scheduled HTTPS tick (60s adaptive 15–300s) → `POST /api/internal/outbox-tick` (CRON_SECRET bearer) → `pg_try_advisory_lock` single-flight → claim N≤100 or 50s (`SKIP LOCKED`, `claimed_until` lease) → idempotent handlers (`event_id` dedupe) → per-message commit, failures to `next_retry_at`/dead-letter → summary JSON. Separate claim pool for webhooks; per-workspace per-tick throttle; crash-safe by lease + lock release. Outbox stays the source of truth; promotion to pg-boss on lag/volume triggers.

## 7. Validation model (canonical)
`Canonical field def → generated Zod ⟷ derived JSON Schema (draft-07 simple only) + uiSchema → RJSF (stub ValidatorType [no AJV in prod bundle] + noValidate) + RHF/Zod client gate → Zod issues → extraErrors + extraErrorsBlockSubmit → [FIX-002 finalized boundary:] API/BFF server re-derives Zod from the pinned publishedVersion snapshot and revalidates authoritatively in TypeScript (pre-RPC); the intake RPC enforces database/security invariants but NEVER executes Zod.` Client/server share one generator; divergence = P0. [CONFIRMED against RJSF v6.11.0 docs: custom ValidatorType allowed; noValidate/extraErrors/extraErrorsBlockSubmit first-class; validator prop still required — satisfied by stub.]

## 8. Version model
`schemaVersion` (contract, migrators) · `draftRevision` (mutable OCC counter on the single Draft; autosave bumps; PATCH requires base match, 409 otherwise) · `publishedVersion` (immutable snapshot number; publish under advisory lock; rollback = republish; old submissions render from pinned snapshot) · `rendererVersion` (compat/build tag `rjsf-6.11+drvN`). Clone = new form namespace + mapping-minus-secrets (`needs_reauth`). AI edits Drafts only through the human gate.

## 9. Tenant model
Every first-class tenant row carries immutable `workspace_id` (updates rejected by trigger; move = clone). Only 6 inheritors omit it (`submission_tags`, `status_history`, `integration_runs`, `webhook_deliveries`, `notification_log`, `report_runs`) — each parent-joined, non-deferrable link, never addressed without its parent, parent workspace immutable. Composite FKs `(workspace_id, parent_id)` wherever both sides carry it. Grants RPC-minted with same-workspace/action-subset validation + orphan sweep.

## 10. Spike gate
| Spike | Gates | Status entry |
|---|---|---|
| S3 RLS | Phase 1 | SPIKES.md + BUILD-ORDER Ph1 |
| S1 engine/Zod, S2 derivation | Phase 2 | SPIKES.md + BUILD-ORDER Ph2 |
| S8 realtime | Phases 3/7 | SPIKES.md |
| S5 budgets | Phase 5 | SPIKES.md + BUILD-ORDER Ph5 |
| S4 scale, S6 AV | Phase 6 | SPIKES.md + BUILD-ORDER Ph6 |
| S7 queue, S9 webhooks | Phase 8 | SPIKES.md + BUILD-ORDER Ph8 |
| S10 metering | Phase 9 | SPIKES.md + BUILD-ORDER Ph9 |

## 11. Implementation readiness
**FORMOS-IMPL-001 may begin at Phase 0.** The 5 P0 contradictions are resolved in-document; remaining spikes are implementation-gated validation with acceptance criteria and fallbacks (S1→JSON Forms fallback, S4→wider materialization, S7→early pg-boss, S6→commercial scan), not open architectural choices. Launch gates (TESTING.md: RLS matrix + 12 FIX-001 isolation tests + intake-RPC E2E + closed spikes + restore drill) and flagged legal/security reviews (BAA/DPA, PCI SAQ-A at V1, ESIGN/IT-Act before signatures) are unchanged and explicit.
