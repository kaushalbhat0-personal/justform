# Testing Architecture

## Pyramid
Unit (domain/rules/calc interpreter, derivations, quota math) · Integration (API + DB under RLS) · **RLS/security matrix (mandatory)** · Contract (OpenAPI + webhook signature) · Renderer/builder E2E (prefill, logic, save-continue, offline queue) · Accessibility (axe + keyboard + SR) · Performance/load (budgets from RENDERER-EMBED) · Abuse (flood, EICAR, polyglot, SVG) · Migration (version rollback, clone-without-secrets) · Backup/restore drill.

## Authorization test matrix (EVERY role × sensitive resource)
Roles: Owner/Admin/Builder/DataCollaborator/Viewer/anon (+ assignee/non-assignee for submissions). Resources: forms, drafts, versions, publications, submissions, attachments, comments, assignments, table_views, exports, integrations, webhooks, api_keys, billing, members, invites, grants, audit. Cells assert allow/deny for create/read/update/delete/share/export — generated from ADR-007's matrix so the test cannot drift from policy. Extra assertions: direct INSERT to `resource_grants` denied for all app roles (RPC-mint only); `workspace_id` UPDATE denied on every table (immutability trigger); API-key cross-workspace URL swap → uniform 404. Denials must also assert audit-sampling behavior.

## Tenant-isolation attacks (all must fail closed)
Workspace A → B read / update / delete / export · public link → private (unpublished) form · member → admin operation (invite, integration, key, billing) · anon direct INSERT to ANY table incl. submissions (no anon table grants exist; intake RPC only) · grant self-escalation incl. direct grant-table INSERT · `workspace_id` UPDATE attempt · cross-workspace API URL swap (`:ws_id` of B with A's session/key → 404) · replayed/expired invite + email-mismatch accept · foreign/expired signed URL · intake/worker RPC invoked with wrong caller key · enumeration sweep (neighbor UUIDs → uniform 404, timing-neutral).

## Pipelines & budgets
Renderer: Lighthouse CI (LCP/INP/CLS gates for the [spike-criterion→launch-SLO] budgets), bundle-size gate (≤50KB critical [architecture target]), AJV-absence gate (no `ajv` module in prod renderer bundle [Spike 1e]), k6 public-render + submit (p95 accept ≤500ms excl uploads [launch SLO]; 100rps no loss [architecture target, S7-gated]; 500rps pre-launch [launch SLO]). Builder: 100-field interaction <1.5s p75 [spike criterion S1], autosave convergence. Abuse: burst + XSS + malware fixtures (EICAR + polyglot + SVG) on intake AND file pipeline. Migration: publish→rollback→render-old-version; clone preserves mapping minus secrets; re-auth required. Backup: PITR restore rehearsal with RLS re-verification + outbox replay.

## MVP gate (non-negotiable before launch)
RLS matrix 100% pass + isolation-attack suite pass (incl. the 12 FIX-001 threat-model tests) + submission-pipeline E2E via API/BFF→RPC (incl. idempotent double-submit; Zod-422 with zero DB rows on invalid payload; anon-direct-INSERT denial; anon EXECUTE on intake function denial; service-role key absent from request path) pass + all gating spikes S1–S10 closed + restore drill recorded. Fail any → no launch.
