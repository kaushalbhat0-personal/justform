# Module Boundaries — ownership, interfaces, events

Legend: `RESP` (≤2 lines) | `SoT` source of truth | `OWNS` tables | `IF` public interface | `DEPS` may depend on | `FORBID` must not import | `EV` emits/consumes.
Rule: dependencies flow inward toward `forms`/`submissions`; `billing`/`metering`/`audit` are sidecars (core logic reaches them only via events).

### identity
RESP: Auth wrapper; user profile + session. No workspace logic. | SoT: auth provider + `profiles` | OWNS: `profiles` | IF: `getSessionUser(), requireUser()` | DEPS: none | FORBID: workspace/forms/billing | EV: emits `user.created`

### workspace
RESP: Workspaces, memberships, invites. Tenant root. | SoT: `workspaces, memberships` | OWNS: those + `invitations` | IF: `requireWorkspaceRole(ws, minRole)` | DEPS: identity | FORBID: forms/submissions internals | EV: `workspace.created/member.added`

### authorization
RESP: Single RBAC evaluator (workspace roles + per-resource grants). | SoT: policy code + `memberships/resource_grants` | OWNS: `resource_grants` | IF: `can(user, action, resource)` | DEPS: identity, workspace | FORBID: direct DB writes to other modules | EV: consumes `member.added`

### forms
RESP: Form CRUD, canonical-schema validation, versioning orchestration. Draft plane only; never serves public traffic. | SoT: `forms` (identity/lifecycle) + `form_drafts` + `form_versions` | OWNS: `forms, form_drafts, form_versions` | IF: `FormsService.create/update/validate/publish()` | DEPS: workspace, authorization | FORBID: submissions, billing, renderer | EV: `form.updated/published/unpublished`

### form-builder
RESP: Pure client editor state (DnD, undo, property panel). No fetch/DB. | SoT: none (ephemeral) | OWNS: none | IF: `<Builder schema onSave>` | DEPS: forms-engine, ui | FORBID: database, api, auth | EV: none

### form-renderer
RESP: Pure renderer for preview + public `/f/:publicId` + embed. Read-only. | SoT: none | OWNS: none | IF: `<Renderer snapshot mode>` | DEPS: forms-engine | FORBID: database, mutations | EV: none

### publishing
RESP: Draft → immutable snapshot + slug/share binding. Sole public-read path. | SoT: `form_publications` | OWNS: `form_publications` | IF: `publish(formId), unpublish(), resolveSlug()` | DEPS: forms, authorization | FORBID: submissions writes | EV: `form.published/unpublished` (renderer cache purge listens)

### submissions
RESP: Ingest + validate + store responses. Transactional core. No email/webhook inline. | SoT: `submissions, submission_index` | OWNS: those + `status_history` | IF: `submit(publicCtx, payload)` | DEPS: publishing (snapshot), metering (quota), files | FORBID: notifications/webhooks/billing calls | EV: `submission.created` (all async flows listen)

### inbox
RESP: Per-form response triage — read/star/assign/status/comment. Thin projection over submissions. | SoT: none (projection) | OWNS: `submission_reads` | IF: `InboxQuery` hooks | DEPS: submissions, authorization | FORBID: direct submission inserts | EV: consumes `submission.created`

### tables
RESP: Submission grid (sort/filter/views). Read projection + saved views. | SoT: `table_views` | OWNS: `table_views` | IF: `TablesQuery` | DEPS: submissions | FORBID: mutating submissions | EV: consumes `submission.created`

### notifications
RESP: Email/in-app on submission, invites, comments. Template + queue only. | SoT: `notifications` | OWNS: `notifications, notification_prefs` | IF: none (event-driven) | DEPS: workspace | FORBID: importing submissions logic | EV: consumes `submission.created, member.added`

### webhooks
RESP: Per-form HTTP delivery with signing + retries + logs. | SoT: `webhooks, webhook_deliveries` | OWNS: those | IF: `register/list/test/rotateSecret` | DEPS: none (payload via event) | FORBID: submissions DB | EV: consumes `submission.created`

### api
RESP: Public REST `/api/v1` (keys) + internal thin adapters. Auth + throttling only. | SoT: `api_keys` | OWNS: `api_keys, api_usage` | IF: REST endpoints | DEPS: authorization + per-domain service | FORBID: business logic (delegate) | EV: none (emits audit via middleware)

### metering
RESP: Usage counters + quota gate. | SoT: `usage_counters` + `usage_ledger` | OWNS: those | IF: `checkQuota(ws, metric), increment()` | DEPS: workspace | FORBID: pricing/gateway SDKs | EV: consumes `submission.created`; emits `quota.exceeded`

### billing
RESP: Plans, entitlements, and (V1) provider subscriptions. Reads metering, never writes product tables. | SoT: OUR DB (`plans` mirror + usage ledger); provider dashboard is never authoritative | OWNS: `plans` (MVP) + `subscriptions, invoices` (V1-flagged, NOT scaffolded in MVP) | IF: `getEntitlements(ws)` (MVP) + `checkout()` (V1 only, dead interface until ADR-020 gate) | DEPS: metering, workspace | FORBID: forms/submissions | EV: consumes `quota.exceeded`; emits `plan.changed`

### files
RESP: Presigned upload/download, MIME/size guard, quarantine→clean promotion, orphan GC. | SoT: storage bucket + `attachments` | OWNS: `attachments` | IF: `presign(), attach()` | DEPS: workspace | FORBID: submission validation | EV: `file.uploaded/scanned` / consumes `submission.created` (attach)

### audit
RESP: Append-only log (who did what). Written via trigger/event, never blocking the hot path. | SoT: `audit_log` | OWNS: that | IF: `AuditQuery` (read) | DEPS: none | FORBID: synchronous calls in hot path (use event) | EV: consumes filtered `*`

### analytics
RESP: Aggregates (views→conversion, per-field drop-off). V1 = PG rollups; external warehouse only later. | SoT: `analytics_daily` | OWNS: that | IF: `getFormStats()` | DEPS: publishing | FORBID: raw PII export | EV: consumes `submission.created, form.viewed`

### integrations
RESP: OAuth connections + per-provider adapters (Sheets, Slack, Drive first). Credentials vaulted. | SoT: `integrations` (secret write-only) | OWNS: `integrations, integration_runs` | IF: `connect(), run(provider, event)` | DEPS: workspace | FORBID: provider SDK in core | EV: consumes `submission.created`

--- LATER MODULES (reserved names — do NOT scaffold now; clean extension points, flagged off) ---
### workflows
RESP: Trigger→condition→action automation (approvals/tasks later). DEPS: submissions+integrations+notifications. EV: consumes `submission.created`. FORBID: any V1 code refs.

### payments
RESP: In-form collection (Razorpay/UPI first, Stripe second). Owns `orders`. DEPS: forms, billing. FORBID: touching the submission transaction (reconcile-then-fulfill).

### documents
RESP: Submission→document generation (certs/PDFs, worker + headless). Async only.

### signatures
RESP: E-sign blocks with tamper-evident trail. DEPS: documents, audit. Needs ESIGN/UETA + IT-Act counsel before build.

### pdf
RESP: PDF Editor + Smart-PDF-equivalent import. DEPS: documents, forms. Smart import = V2+ (scope explicitly deferred).

### apps / portals / marketplace
RESP: Bundles (forms/tables/reports/links), auth-gated portals, public template gallery. All read via publishing snapshots.

### ai
RESP: Prompt→form generation, chatbot edit, spam/partial recovery, insights. Stateless LLM proxy; PII redaction + human-approval for destructive ops; never trains on tenant data. DEPS: forms.

### enterprise
RESP: SSO/SAML/SCIM, audit export/SIEM, residency pinning, DPA/BAA posture. Cross-cutting flags consumed by authorization/billing.
