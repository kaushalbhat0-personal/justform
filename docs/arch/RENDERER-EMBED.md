# ADR-015/016 — Public Renderer + Embed Strategy

## Status
DECIDED (accepted 2026-10-28; Spike 5 bounded confirmation before Phase 5).

## Context
Embed weight and mobile fragility are documented competitor failure modes (Typeform perf complaints, mobile page-transition bugs — recon §8). Lightweight embed + mobile resilience is a FORMOS differentiator, so budgets are architectural, not aspirational.

## Decision
- **Hosted URL:** `/f/{publicId}` — 22-char unguessable (~130-bit entropy), never sequential; optional per-workspace custom slug `/f/{slug}` (3–60 chars, rate-limited lookup against enumeration). Public always serves the **published version** (`?v=` ignored); drafts never public; unpublish → 410. Private/share links `/s/{shareToken}` (password/expiry-checked server-side, `noindex`).
- **Renderer:** RSC shell (chrome, SEO meta from form — no PII, theme CSS) + **client islands per field** (heavy inputs — signature, file, payment, matrix — lazy on viewport/interaction). Schema fetched at a versioned URL, edge-cached by `(form_id, version)`, immutable → `max-age=31536000, immutable`. Prefill (`?prefill__{field}=`, allowlisted fields only) parsed **server-side**, sanitized, injected into initial state; file/payment/signature never prefillable.
- **Embed:** iframe-only for MVP via a **<5KB gzipped loader** (total critical ≤50KB: loader 5KB + shell 25KB + validation/logic core 20KB; field islands stream after). Loader does only: lazy-on-viewport, `postMessage` auto-resize (validated origin), UTM/prefill passthrough (allowlisted, encoded), consent-flag forward, no-JS fallback link. Loader never renders fields, holds schema, validates, or stores PII. `sandbox="allow-scripts allow-forms allow-same-origin"` (+ camera/mic only when a file field needs it).
- **Full JS-embed: DEFERRED** — iframe covers ~95% of MVP cases; JS-embed adds CSS leakage, XSS surface, and white-label theming debt. Revisit at Stage 3.

## Alternatives Considered
- **SSR-everything (server-render fields):** rejected — kills edge-cacheability of the immutable schema and complicates per-field interactivity; shell-RSC + client islands is the middle path.
- **JS-embed now:** rejected (above). **One-loader-per-field:** rejected — chatty, CLS-prone.

## Budgets (validated — Spike 5 confirms on real devices before Phase 5)

| Metric | Target | Why |
|---|---|---|
## Budgets (labels: [T] = architecture target, [S] = spike acceptance criterion, [SLO] = launch SLO — nothing is called "validated" until measured)

| Metric | Target | Class | Why |
|---|---|---|---|
| Critical JS (renderer) | ≤50KB gzip | [T] (CI gate) | 4G Moto-G parse <1s; islands defer the rest |
| LCP | ≤2.5s p75 (4G) | [S→SLO] (Spike 5) | SEO + conversion; shell streams, no webfont block |
| INP | ≤200ms p75 | [S→SLO] (Spike 5) | per-field islands keep main thread free |
| CLS | ≤0.05 | [S→SLO] (Spike 5) | reserved min-heights + skeleton; resize via rAF |
| p95 form-load (schema) | ≤600ms IN | [T] | edge-cached immutable schema (hit ~50ms, cold ~400ms) |
| p95 submission accept | ≤500ms excl uploads | [SLO] (proven in S4/S7 load tests) | async uploads + webhooks; DB insert + RLS <200ms, enqueue <50ms |

## Security / Abuse
Per-IP + per-form rate limits (30 views/min, 5 submits/min), WAF + adaptive Turnstile (only after anomaly, never default friction), honeypot + time-to-submit heuristics, upload-grants only, uniform-404 enumeration defense, hashed-IP logging (30d), 10×-spike alert.

## Migration
Budgets are enforced in CI (Lighthouse + bundle-size gates); breaching them blocks release. JS-embed promotion requires a fresh ADR.
