# Submission Pipeline — two layers, one writer (finalized — FIX-002)

Execution-boundary rule (normative): **PostgreSQL cannot execute TypeScript/Zod. Therefore Zod NEVER runs "inside" the RPC.** Application/schema validation lives in the API/BFF (TypeScript); database/security enforcement lives in the RPC (PL/pgSQL). Both are mandatory, in that order. Neither implies the other.

```text
Anonymous Browser
      ↓
Public Intake API / BFF (TypeScript)
      ↓
publication lookup / redacted metadata
      ↓
CAPTCHA / abuse / rate limiting (BEFORE any DB write)
      ↓
server-side generated Zod validation (pinned publishedVersion snapshot)
      ↓
SCOPED SECURITY DEFINER intake RPC  ←── the ONLY database writer
      ↓ single Postgres transaction
      ├── submission
      ├── submission field/index materialization
      ├── attachment references (pre-scanned refs only)
      └── outbox event
      ↓
receipt-only response
```

Direct browser→RPC invocation is NOT a supported path: the intake function is **not exposed to `anon`/`authenticated` via PostgREST** (no EXECUTE grant), so server-side Zod cannot be bypassed by calling the RPC directly. The API route calls the RPC through a dedicated least-privilege `intake_caller` role holding **only** `EXECUTE` on the intake function — zero table grants, zero RLS bypass, never the service-role key. (Service-role remains confined to background workers per ADR-006.)

## Authorization boundary (normative)
- **Anon role:** `SELECT` → only the explicitly approved redacted-publication-metadata path; `INSERT` → DENIED; `UPDATE` → DENIED; `DELETE` → DENIED. `authenticated` holds zero grants on `submissions`, `submission_index`, `attachments`, `outbox`, and zero EXECUTE on the intake function (members submit through the same API/BFF path, never direct writes).
- **Submission creation: only through the scoped SECURITY DEFINER intake RPC.** The RPC offers **no SELECT-back** (returns only a receipt `{submission_id, status}`).
- **Layer 1 — API/BFF (TypeScript, Zod authority):** publication lookup (redacted), Turnstile/captcha + honeypot + time-to-submit, per-IP/form/respondent-key rate limiting, then generated Zod validation re-derived from the pinned `publishedVersion` snapshot (field validation + rules + calcs + custom validators, same generator as the client). Field-level failures → 422 with field errors, **no RPC call, no DB touch**. Only a Zod-clean payload is forwarded, with a request-scoped idempotency key.
- **Layer 2 — RPC (PL/pgSQL, integrity authority):** independently re-verifies everything time- or trust-sensitive **inside the transaction**: publication exists + active + schedule-open; `workspace_id` resolved **from the publication row, never from any caller parameter** (caller-supplied workspace identifiers are ignored and logged-and-rejected); caps; unique-field checks (advisory lock for races); idempotency dedupe on `(form_id, key)` 24h; attachment refs exist + scanned-clean + belong to this form session; defensive shape/type checks (NOT NULL, length caps, FK existence — integrity floor, NOT schema semantics; a violation here is a 500-class integrity rejection + alert, since it means Layer 1 was bypassed). Then INSERTs + outbox atomically. Caps/schedule/unique → 409/410; rollback on any failure; client retries with the same idempotency key.
- RPC hardening (mandatory, CI-tested): owned by a locked-down non-login role; `SET search_path = pg_catalog, pg_temp`; strict parameter types; no dynamic SQL (or `format(%I/%L)`-only); 404-uniform on miss/inactive publication.
- Authenticated (member) submissions and save-continue resume use the same two layers (API/BFF Zod + same RPC family with an added membership assertion) — never direct table writes from the app tier. Workers (fan-out) run service-role with `workspace_id`-pinned payloads and never accept caller workspace scope.

## Stages
1. **GET published form** — resolve Publication by publicId → pinned `(form_id, publishedVersion)` snapshot. Fail: 410/404 → no render, no leak.
2. **Render** — client derives JSON Schema/uiSchema/Zod from snapshot. Fail: snapshot mismatch → refetch; unknown field → ignore + flag.
3. **Prefill** — query/auth/integration sources fill defaults. Fail: prefill errors never block; log + continue empty.
4. **Client validation** — generated Zod + rule/calc interpreter; inline errors, no network call.
5. **API/BFF gate (no DB writes)** — transport checks → 429/reject; then Zod revalidation against the pinned snapshot. Fail: 422 field errors, nothing persisted, RPC never called.
6. **Intake RPC (single transaction)** — in-txn invariant enforcement per above; INSERT submission + side-index rows; link pre-scanned attachment refs; write outbox `submission.completed`. Fail: 409/410/500-class integrity rejection; rollback.
7. **Event** — outbox row committed atomically with the submission. No commit without event; no event without commit.
8. **Async fan-out** — notifications, integrations/webhooks (retry + DLQ), analytics rollup, index backfill verify, metering. Failures never roll back the submission.

## Cross-cutting
- **Duplicates:** client `Idempotency-Key` per intent (new key on intentional resubmit). Server dedupe 24h on `(form_id, key)` inside the RPC transaction.
- **Anonymous identity:** `respondent_key` (random, cookie+localStorage); optional `save-continue token` (opaque, hashed server-side) emailed to resume. Partials: `status=draft_partial` rows, 30-day TTL, excluded from caps/analytics until promoted through the same two layers.
- **Spam quarantine:** `review` scores land in quarantine (API-layer decision); moderator approve/reject; never counted until approved.
- **Enforcement points (Layer 1 validates, Layer 2 enforces in-txn; client hints only):** schema/required → 422 (Layer 1); schedule window → 410, caps → 409, unique-field → 409 (Layer 2).

```text
Browser              API/BFF (TS, Zod)            DB (intake RPC, one txn)
  | GET /f/:publicId ---> |                                |
  | <--- snapshot (vN) -- |                                |
  | render + prefill     |                                |
  | Zod client ok        |                                |
  | POST submit + Key -> | captcha/rate checks           |
  |                      | Zod revalidate (pinned vN)     |
  |                      | 422 on field errors, no call  |
  |                      | CALL intake_rpc(clean) ------->|
  |                      |   verify publication/sched    |
  |                      |   caps/unique/idempotency     |
  |                      |   defensive shape checks      |
  |                      |   insert sub+index+outbox     |
  | <--- receipt -------- |                                |
  |                      |      fan-out ---> workers (service-role, pinned ws)
```
