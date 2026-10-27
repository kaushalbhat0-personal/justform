# FORMOS-ARCH-001 — Architecture Verdict

## Scorecard

| Dimension | Score /10 | Reason |
|---|---|---|
| Multi-tenancy | 9 | Single-DB workspace boundary + deny-default RLS + composite-FK discipline; −1 for unproven-at-scale membership helper (Spike 3) |
| Security | 8 | Threat-modeled T1–T10, RPC-only membership writes, quarantine files, never-log list; −2 pending pen-test + counsel reviews (flagged, pre-launch) |
| RBAC | 9 | 5 roles + expiring grants + matrix-tested; −1 for future custom roles (data-reserved, not built) |
| Form engine | 8 | Canonical-owned RJSF+RHF+Zod, replaceable renderer, SurveyJS explicitly rejected; −2 pending Spike 1 R19 confirmation |
| Schema portability | 9 | JSON-Schema-derivable open canonical, migrators, alias renames; unknown-field-tolerant |
| Builder scalability | 7 | Islands + locks + budgets defined; −3 pending real 100-field profiling (Spikes 1/2/8) |
| Renderer performance | 8 | RSC shell + immutable edge schema + ≤50KB critical + CI gates; −2 pending device-lab proof (Spike 5) |
| Submission scalability | 8 | Single-txn ingest + hybrid answers + outbox fan-out; −2 pending 100k query proof (Spike 4) |
| Collaboration | 8 | Assignee/SLA/status/comments + locks + LWW tables; CRDT correctly deferred |
| API | 9 | Versioned REST, cursor pagination, OAuth-ready scopes, OpenAPI path, 1:1 MCP mapping |
| Webhooks | 9 | HMAC + replay window + backoff + DLQ + delivery-log API; retry math bounded by Spike 9 |
| Metering | 8 | Counters + immutable ledger + pooled limits + no-hostage rules; −2 pending concurrency proof (Spike 10) |
| Extensibility | 9 | Events, `x-` registry, provider ports, flagged-off modules with reserved names |
| Cost efficiency | 9 | Genuine ₹0 Stage 0 with explicit paid-exit triggers; no managed Kafka/Redis/ES/Temporal |
| Jotform parity path | 8 | Every recon surface maps to a module + phase (V1/V2/V3); Smart-PDF + agents correctly late |
| Enterprise readiness | 7 | Residency/SSO/BAA paths reserved (region column, provider interfaces) but unbuilt by design |
| AI readiness | 7 | Redaction + draft-only + review-gate architecture set; provider/eval harness deferred to V2 |

## FINAL VERDICT: ARCHITECTURE READY WITH SPIKES

P0 architecture is decided (32 DECIDED, 0 undecided-P0). Six decisions carry bounded spikes with acceptance criteria and failure fallbacks (S1 engine-compat → Phase 2; S4 query-scale → Phase 6; S3 RLS-perf → Phase 1; S5 renderer budgets → Phase 5; S6 AV pipeline → Phase 6; S9/S10 webhook/metering → Phases 8/9) — all recorded in SPIKES.md with failure→decision rows, so no spike can silently become a blocker. Six regulated/scale-premature areas are explicitly DEFERRED with triggers (workflows/Temporal, payments, signatures, PDF/Smart-import, AI, residency/SSO-BAA). Nothing is ARCHITECTURE BLOCKED: the MVP fence (MVP-FENCE.md), build order (BUILD-ORDER.md), launch gates (TESTING.md), and risk register (RISK-REGISTER.md) are complete and consistent.

**To reach full READY:** execute Spikes S1–S10 in build order, record outcomes in the owning ADRs, run the RLS matrix + isolation suite + restore drill, and obtain the flagged legal/security reviews (BAA/DPA stance, PCI SAQ-A letter at V1, ESIGN/IT-Act counsel before signatures). Then FORMOS-IMPL-001 may begin at Phase 0.

## Reconciliation amendment — FORMOS-ARCH-FIX-001 (2026-10-28)
Reconciliation review (13 issue areas, 5 P0) completed with **no redesign**: (1) MVP billing = plans/entitlements/counters/ledger/quotas/usage-screen/CTA + dead `BillingProvider` port; live checkout/subscriptions/invoices/refunds/top-ups moved to V1 (METERING-BILLING.md, MVP-FENCE.md, BUILD-ORDER Phase 9, ADR-020, MODULE-BOUNDARIES). (2) Stage 0 worker = scheduled bounded outbox tick (cron-secret + advisory-lock single-flight, N=100/50s, lease-safe) — no persistent process (QUEUE-WORKERS.md, EVENTS-ASYNC.md, SYSTEM-ARCHITECTURE.md, DEPLOY-BACKUP-FLAGS.md). (3) Public submission = intake-RPC-only; zero anon table grants (SUBMISSION-PIPELINE.md, RLS-THREAT-MODEL.md, ADR-006/007, DATABASE-MODEL.md, API-WEBHOOKS.md). (4) Tenant columns classified: explicit `workspace_id` everywhere except 6 Rule-2 inheritors; `workspace_id` immutable, cross-workspace move = clone (DATABASE-MODEL.md, ADR-006). (5) Validation pipeline verified against RJSF v6.11.0 docs: stub ValidatorType + `noValidate` + `extraErrors`/`extraErrorsBlockSubmit`, AJV excluded from prod, Zod sole authority (ADR-003, FIELDS.md, SPIKES.md S1). (6) MVP = 12 field types with per-type contracts (FIELDS.md, new). (7) Version terms disambiguated (`schemaVersion`/`draftRevision`/`publishedVersion`/`rendererVersion`; VERSIONING.md). (8) URL `ws_id` = locator, never authority; key binding immutable + uniform-404 mismatch (API-WEBHOOKS.md, RLS-THREAT-MODEL.md, TESTING.md). (9) Grants RPC-minted only with same-workspace/action-subset validation + orphan sweep (ADR-007, DATABASE-MODEL.md). (10) Spike gates mapped to phases with normative ordering (SPIKES.md, BUILD-ORDER.md). (11) Performance claims labeled [T]/[S]/[SLO] (RENDERER-EMBED.md, TESTING.md). Status remains **ARCHITECTURE READY WITH SPIKES** — see FORMOS-ARCH-FIX-001.md for the implementation gate.
