# ADR Index — FORMOS-ARCH-001 (38 decisions)

Status key: DECIDED · SPIKE REQUIRED (bounded, with acceptance criteria in SPIKES.md) · DEFERRED (explicitly later, with trigger) · REJECTED.

| ADR | Title | Status | Disposition |
|---|---|---|---|
| ADR-001 | Overall architecture style: modular monolith, single deployable, explicit module boundaries | DECIDED | SYSTEM-ARCHITECTURE.md, MODULE-BOUNDARIES.md |
| ADR-002 | Frontend/framework: Next.js App Router + React + TS, RSC shell + client islands | DECIDED | SYSTEM-ARCHITECTURE.md, MONOREPO.md |
| ADR-003 | Form engine: RJSF + RHF + Zod hybrid; RJSF validation bypassed (noValidate + stub ValidatorType + extraErrorsBlockSubmit), AJV excluded from prod, Zod sole authority | DECIDED (Spike 1 re-verifies per §14 criteria incl. no-AJV bundle proof) | ADR-003-form-engine.md |
| ADR-004 | Schema strategy: owned canonical FORMOS schema; JSON Schema/uiSchema/Zod derived; MVP = 12 types (FIELDS.md); draft_Revision vs published_Version terminology | DECIDED | FORM-SCHEMA.md, FIELDS.md |
| ADR-005 | Versioning: Draft (draftRevision, OCC) → FormVersions (publishedVersion, immutable) → Publications (channel binding); rollback = republish | DECIDED | VERSIONING.md |
| ADR-006 | Tenancy: single PG, workspace boundary, portable SQL, Supabase-hosted Stage 0 | DECIDED | ADR-006-tenancy.md |
| ADR-007 | Authorization: 5 roles + expiring resource grants; no frontend-only authz | DECIDED | ADR-007-authorization.md |
| ADR-008 | RLS: deny-by-default, session-derived tenant, RPC redaction, service-role isolation | DECIDED | RLS-THREAT-MODEL.md |
| ADR-009 | Answers: hybrid JSONB + materialized side index + relational attachments; explicit workspace_id + Rule-2 inheritance | DECIDED (Spike 4 tunes cap/scale) | ADR-009-answers.md, DATABASE-MODEL.md |
| ADR-010 | Realtime: presence + locks + patches; CRDT deferred | DECIDED | REALTIME.md |
| ADR-011 | Events: outbox envelope, domain/integration/audit classes, no Kafka | DECIDED | EVENTS-ASYNC.md |
| ADR-012 | Queue/workers: MVP = scheduled bounded outbox tick (no persistent process; N=100/50s, advisory-lock single-flight) → V1 pg-boss (bias) / Inngest | DECIDED | QUEUE-WORKERS.md, EVENTS-ASYNC.md |
| ADR-013 | Workflow durability: Temporal only at human-in-loop scale; outbox/pg-boss until then | DEFERRED | QUEUE-WORKERS.md (triggers); module reserved, flagged off |
| ADR-014 | Files: quarantine-by-default + async ClamAV; signed grants; refs-only attach | DECIDED (Spike 6 confirms scan SLO/cost) | FILE-PIPELINE.md |
| ADR-015 | Public renderer: RSC shell + field islands, edge-cached immutable schema | DECIDED (Spike 5 confirms budgets) | RENDERER-EMBED.md |
| ADR-016 | Embed: iframe + <5KB loader, ≤50KB critical; JS-embed deferred | DECIDED | RENDERER-EMBED.md |
| ADR-017 | API: REST v1, cursor pagination, error envelope, OAuth-ready scopes, OpenAPI | DECIDED | API-WEBHOOKS.md |
| ADR-018 | Webhooks: HMAC signing, replay window, backoff + DLQ, delivery-log API | DECIDED (Spike 9 hardens retry math) | API-WEBHOOKS.md, SPIKES.md |
| ADR-019 | Metering (MVP, no money): counters + immutable ledger, pooled limits, hard/soft enforcement, usage screen + upgrade CTA | DECIDED (Spike 10 verifies accuracy) | METERING-BILLING.md, SPIKES.md |
| ADR-020 | Billing: provider port as DEAD interface in MVP (Razorpay/Stripe selected, not integrated); live checkout/subscriptions/invoices/refunds/top-ups = V1 gated by billing-terms review | DECIDED | METERING-BILLING.md, MVP-FENCE.md, BUILD-ORDER.md |
| ADR-021 | Audit: append-only, hot 90d + cold 1yr+, enterprise export path | DECIDED | AUDIT-OBSERVABILITY.md |
| ADR-022 | Observability: structured logs, RED, OTel, Sentry, never-log list, MVP alerts | DECIDED | AUDIT-OBSERVABILITY.md |
| ADR-023 | Search/tables: PG FTS + trigram + GIN; keyset + materialization ladder; no ES at MVP | DECIDED | SEARCH-TABLES-ANALYTICS.md |
| ADR-024 | Analytics: operational counters vs analytical rollups; drop-off via step events | DECIDED | SEARCH-TABLES-ANALYTICS.md |
| ADR-025 | Notifications: template + queue, event-driven, prefs + channels later | DECIDED | MODULE-BOUNDARIES.md, EVENTS-ASYNC.md |
| ADR-026 | Integrations: per-provider adapters, vaulted OAuth, 1 provider at MVP | DECIDED | MODULE-BOUNDARIES.md, SECURITY-ARCHITECTURE.md |
| ADR-027 | Secrets: vault/env-only, rotation, write-only webhook/integration secrets, CI scan | DECIDED | SECURITY-ARCHITECTURE.md |
| ADR-028 | Payments: gateway-hosted only (SAQ-A), reconcile-then-fulfill — V1, NOT MVP | DEFERRED | MVP-FENCE.md; trigger: V1 gate (billing live + counsel review) |
| ADR-029 | E-sign: tamper-evident trail + counsel review — V2, NOT MVP | DEFERRED | MVP-FENCE.md; trigger: ESIGN/UETA + IT-Act counsel sign-off |
| ADR-030 | PDF: generation V2, Smart-PDF-equivalent import V2+ scoped later | DEFERRED | MVP-FENCE.md; trigger: V2 gate + scope ADR |
| ADR-031 | AI: redacted stateless proxy, draft-only edits, review gates — V2+, NOT MVP | DEFERRED | SECURITY-ARCHITECTURE.md; trigger: PII-redaction + DPA + eval harness |
| ADR-032 | Localization: i18n keys in canonical schema, per-field translations, 45-lang ambition later | DECIDED (schema-ready, UI later) | FORM-SCHEMA.md |
| ADR-033 | Compliance/residency: region column reserved, per-region DB path, no promises at MVP | DEFERRED | DEPLOY-BACKUP-FLAGS.md; trigger: first residency customer + counsel |
| ADR-034 | Deployment: Stage 0 ₹0 → 1 → 2 → 3 with explicit exit triggers | DECIDED | DEPLOY-BACKUP-FLAGS.md |
| ADR-035 | Backup/recovery: dumps + PITR, RPO ≤24h / RTO ≤4h MVP, recorded drill | DECIDED | DEPLOY-BACKUP-FLAGS.md |
| ADR-036 | Testing: RLS matrix + isolation attacks gate launch (TESTING.md) | DECIDED | TESTING.md |
| ADR-037 | Cost/scaling: ₹0 start, per-workspace cost visibility at Stage 2, no premature scale | DECIDED | DEPLOY-BACKUP-FLAGS.md, QUEUE-WORKERS.md |
| ADR-038 | Monorepo/module structure: apps/web + 7 packages + workers, anti-sprawl rules | DECIDED | MONOREPO.md |

Rejected outright (do not revisit without new evidence): schema-per-tenant · DB-per-tenant now · app-filtering-without-RLS · SurveyJS stack (EULA + fees + lock-in) · fully-custom engine now · Formik/Uniforms/Form.io-foundation · Yjs/Liveblocks-as-authority at MVP · Kafka/Temporal/Redis/ES at MVP · JS-embed at MVP · EAV-only answers · per-column RLS · frontend-gated authz · PAN in DB · data-hostage billing.

Deferred with triggers (flagged off, reserved names): workflows/Temporal (ADR-013) · payments (ADR-028) · signatures (ADR-029) · PDF/Smart-import (ADR-030) · AI (ADR-031) · residency/SSO-BAA (ADR-033).
