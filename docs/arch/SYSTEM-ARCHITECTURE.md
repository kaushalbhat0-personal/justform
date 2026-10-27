# System Architecture — FORMOS (Modular Monolith V1)

## 1. System Diagram (single deployable, modular boundaries)

```text
Browser
 ├─ Marketing (static, public)
 ├─ Workspace App (auth, /app/*)
 ├─ Builder (auth, /app/forms/:id/build)
 └─ Public Renderer (/f/:publicId, /s/:shareToken, embed loader)
                        │
                        ▼
Application / API Boundary (Next.js App Router Route Handlers /api/v1/*)
 ├─ Auth (session, MFA, API keys)
 ├─ Workspace / RBAC (grants gate every call)
 ├─ Forms (draft CRUD, validation, versioning)
 ├─ Submissions (transactional ingest only)
 ├─ Tables (read projections, saved views)
 ├─ Workflows (LATER — reserved routes, flagged off)
 ├─ Integrations (OAuth adapters, vaulted secrets)
 ├─ Billing (entitlements, checkout)
 └─ AI (LATER — reserved, flagged off)
                        │
                        ▼
Postgres + RLS (deny-by-default, workspace_id on every tenant row)
 ├─ Object Storage (private buckets, signed URLs; quarantine prefix)
 ├─ Queue (MVP: Postgres outbox + scheduled bounded tick; V1: pg-boss — see QUEUE-WORKERS.md)
 ├─ Workers (tick-driven handlers: notifications, webhooks, AV callback, rollups, GC — service-role only, no persistent process at Stage 0)
 ├─ Search (MVP: Postgres FTS/trigram/GIN; external engine NOT at MVP)
 ├─ Email (Resend free tier → SMTP; async only)
 └─ External APIs (Razorpay/Stripe, OAuth providers — workers only, never browser)
```

Deploy V1: 1× Next.js app + 1× managed Postgres (Supabase free → self-hosted path) + S3-compatible storage + in-repo tick handlers (no separate worker host at Stage 0). No Kafka/Redis/ES at start.

## 2. Layer Contract Matrix

| Layer | Sync/Async | Consistency | Cacheable | Access |
|---|---|---|---|---|
| Marketing (`(marketing)`) | sync, static/ISR | eventual | YES (CDN, 1h) | public |
| Workspace App (`/app/*`, RSC+client) | sync | transactional read | NO (private) | authenticated (JWT cookie) |
| Builder (canvas, DnD, property panel) | sync + optimistic patch | transactional on save | NO | authenticated, Builder+ role |
| Public Renderer (`/f/:publicId`, embed) | sync, edge-cacheable | eventual (published snapshot) | YES (CDN 60s + immutable version URL) | public (unguessable ID, no JWT) |
| API boundary (`/api/v1/*`) | sync <300ms p95, else 202+poll | transactional | NO, except published-schema GET | mixed: public / auth / privileged (service-role in workers only) |
| Postgres + RLS | sync | transactional (ACID) | n/a | RLS on `auth.uid()`→membership; workers bypass audited |
| Object storage | async presigned URLs | eventual | YES (signed URL, short TTL) | private; public only via signed URL |
| Queue + Workers (scheduled tick) | async, retry w/ backoff + DLQ | at-least-once, idempotent handlers | n/a | privileged (cron-secret tick + service-role handlers, `workspace_id`-pinned payload) |
| Search (PG FTS) | async index | eventual (1–60s) | YES | authenticated-scoped |
| Email | async | at-least-once | n/a | privileged |
| External (payments, OAuth) | sync (checkout.js) + async webhook | eventual | NO | privileged, per-workspace vaulted secrets |

Rules: request path never calls workers synchronously; never calls external APIs from browser except presigned upload + gateway checkout.js; no service-role key in browser bundle or general API route.

## 3. Request Flows

### A. Authenticated app request (e.g. list forms)
1. Browser → `GET /app/forms` (RSC) with session cookie.
2. Middleware validates JWT, resolves `workspace_id` from memberships (server-side, cached ≤60s).
3. RSC → Server Action / Route Handler → `packages/database` query with RLS context.
4. Postgres returns tenant-scoped rows. Cross-workspace joins forbidden.
5. Render. Mutations revalidate by `workspace_id + resource_id` tag. Budget p95 <300ms.

### B. Public form render (`GET /f/:publicId`)
1. Edge/Middleware → lookup publication by publicId (public RLS policy: active publication only).
2. Serve pinned `(form_id, version_no)` snapshot from CDN/ISR — never the live draft.
3. Bot/spam config + per-IP rate limit. Never expose drafts, responder data, or `workspace_id`. Views metered async (fire-and-forget).

### C. Public submission (`POST /api/v1/public/forms/:id/submit`)
1. Turnstile/captcha + rate limit (429 on abuse) → server-side Zod revalidation in the API/BFF (TypeScript, derived Zod + rules from pinned snapshot; 422 here = no RPC call, no DB touch).
2. Single transaction: INSERT submission + side-index rows + link attachments + enforce caps/schedule/unique + outbox event.
3. Commit → return receipt (`202 {submission_id}`) in <500ms.
4. Async fan-out: notifications, webhooks (retry + DLQ), tables index verify, audit, metering. Failures never roll back the submission.

### D. File upload (pre-submit)
Client requests single-use upload grant (tied to valid form session + captcha-passed) → presigned PUT to quarantine prefix → AV scan async → txn stores refs only. Orphan GC by TTL.

## 4. Non-negotiables
- RLS ON for every tenant table; CI fails if a migration lacks a policy test.
- All public endpoints rate-limited + schema-validated; all privileged endpoints re-authorize server-side via `authorization` module.
- ₹0 start: PG = DB + queue (outbox/pg-boss) + cron + FTS. No managed Redis/Kafka/ES.
