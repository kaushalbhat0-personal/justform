# ADR-003 — Form Engine: RJSF + RHF + Zod Hybrid on FORMOS Canonical Schema

## Status
DECIDED (accepted 2026-10-28; Spike 1 bounded confirmation required before Phase 2 — see SPIKES.md).

## Context
Builder UX is FORMOS's moat and must be owned, not rented. Requirements: 40+ eventual field types, conditional logic, calculations, multi-page, custom widgets, theming, WCAG 2.2 AA, SSR/App Router, React 19, mobile, offline drafts, PDF mapping, AI generatability, conversational projection, version migration — under a Next.js modular monolith with Postgres RLS. Recon (FORMOS-RECON-001 §10, engine subagent with live GitHub/npm data 2026-10-27) shortlisted four options.

## Decision
Adopt **Option A: RJSF + React Hook Form + Zod hybrid**, driven by an owned **FORMOS canonical schema**. Normative pipeline:

```text
FORMOS canonical schema (sole hand-edited / AI-generated / versioned artifact)
        ↓ derive (build-time + server, never hand-edited)
JSON Schema + uiSchema ──→ RJSF renderer (schema-driven / dynamic surfaces)
Zod schemas (generated) ──→ RHF runtime state + server revalidation (hand-tuned surfaces)
```

Single-source-of-truth rules: (1) canonical owns; (2) JSON Schema / uiSchema / Zod are DERIVED artifacts, regenerated on canonical change; (3) client and the API/BFF server share the Zod generator; the server re-derives from the pinned snapshot and revalidates every submission in TypeScript before the intake RPC is called (Zod never executes inside PostgreSQL — see SUBMISSION-PIPELINE.md); (4) field registry closed + `x-` extensions; unknown types ignore + flag, never crash. All RJSF imports wrapped behind `packages/renderer` so the renderer is replaceable.

## Validation model — canonical pipeline (verified against RJSF v6.11.0 docs, 2026-10-28) [CONFIRMED]
1. **What RJSF renders:** derived JSON Schema (draft-07 simple constructs ONLY — no `anyOf`/`oneOf`/`$ref`/schema-`if-then-else` at render) + uiSchema. Conditional behavior lives in the FORMOS rules interpreter, not in schema conditionals. This constraint exists because RJSF resolves such constructs through its validator (`retrieveSchema()`); keeping them out keeps the renderer validator-independent.
2. **What RJSF validates:** nothing. We pass a minimal FORMOS `ValidatorType` implementation (interface-conformant stub, no AJV code) and set `noValidate` — both first-class supported (`noValidate`: "turns off all validation"; custom implementations allowed "as long as it fulfills the `ValidatorType` interface" [CONFIRMED — form-props + validation docs]).
3. **AJV:** NOT a production runtime dependency — excluded from the prod bundle. Dev-time use for derived-schema sanity checks is permitted (never shipped, never in the hot path).
4. **What Zod validates:** everything. Generated Zod (from canonical field defs) runs client-side (RHF resolver + `onSubmit` gate) and server-side in the API/BFF (re-derived from the pinned `publishedVersion` snapshot). The intake RPC enforces database/security invariants but NEVER executes Zod — see SUBMISSION-PIPELINE.md for the two-layer boundary.
5. **Client/server parity:** the same generator code produces both; divergence is a P0 bug. Server derivation is authoritative.
6. **Error display:** Zod issues are mapped to RJSF's `ErrorSchema` and fed via `extraErrors` with `extraErrorsBlockSubmit={true}` (blocking submit — first-class props [CONFIRMED]). `transformErrors` is unused (no JSON-Schema errors exist to transform); `showErrorList` + `focusOnFirstError` operate on the merged error schema including `extraErrors`. This mapping layer (`zodIssuesToErrorSchema`) is owned code in `packages/forms-engine` and covered by Spike 1.
7. **Bypass status:** intentional and technically supported — `validator` remains a required prop (satisfied by our stub), while actual validation authority is Zod. Pinned: `@rjsf/core` v6.x exact (docs v6.11.0); any major bump re-verifies this section via ADR amendment.

## Alternatives Considered
- **B) SurveyJS (library MIT + Creator/Dashboard/PDF commercial, per-dev fee, EULA with non-compete language [CONFIRMED recon §10]).** Mature builder + logic + PDF + analytics, but: paywalled builder (the exact moat surface), proprietary schema (not portable), EULA risk for a competing builder product, adapter tax on React 19/App Router, small hiring pool, AI must target a proprietary schema. **REJECTED explicitly** — incompatible with owned-moat thesis on licensing + lock-in + cost grounds.
- **C) JSON Forms + RHF/Zod.** JSON-Schema-native, good TS, elegant custom renderers — but ~2.75k stars vs RJSF ~15.9k, fewer widgets/templates, smaller hiring/debugging pool, more custom DnD-builder work. Viable **fallback** if Spike 1 shows RJSF React 19 friction. Not chosen.
- **D) Fully custom renderer/schema engine.** Total UX ownership and ideal perf, but 6–12 months to parity (a11y, validation, repeaters, files, tables, mobile) plus permanent maintenance tax; delays the actual moat (builder polish, AI, conversational). **REJECTED for now**; custom layer lives in the widget registry + hand-tuned RHF surfaces, not a from-scratch core. Revisit only if RJSF becomes a proven blocker.

## Why
Licensing clean (Apache-2.0 + MIT + MIT, $0, no non-compete); JSON Schema is an open portable standard (export/import trivial; constrained FORMOS JSON is high-LLM-fit for AI generation); RJSF `registry.widgets/fields/templates` + `x-` namespace gives an owned extension point without forking; owned rule/calc interpreter (allowlisted operators, no `eval`) covers logic beyond JSON-Schema `if/then`; a11y enforced via custom templates (labels, errors, aria, focus); theming via design tokens → `ui:options` + Tailwind/shadcn templates; SSR via RSC shell + client-island renderer; RHF uncontrolled inputs minimize re-renders; offline = canonical JSON in IndexedDB + queued submissions; conversational = page→turn projection of the same canonical; PDF mapper consumes canonical field ids/keys, never renderer DOM; hiring pool is mainstream React.

## Consequences
Must build and own: canonical→JSON Schema/uiSchema/Zod generator, rule/calc interpreter, field/widget registry, validation-message catalog, schema migrators, a11y template set (~3–4 weeks, vs per-dev fees + legal review for SurveyJS). Hand-tuned surfaces (payment, signature, matrix, conversational turn) use RHF+Zod directly against the same generated Zod schema.

## Security Impact
Derived client validation is never trusted; the API/BFF server re-derives + revalidates from the pinned snapshot (pre-RPC, TypeScript). Calc expressions sandboxed (allowlist, step cap, timeout). Custom validators run server-side with timeouts; HTML/labels sanitized.

## Performance Impact
Budgets: renderer <120KB gz (dynamic import per widget group); field edit <50ms; 100-field form interactive <1.5s p75. RHF `shouldUnregister:false` for show/hide churn; memoized widgets; virtualized repeaters >50 rows. See RENDERER-EMBED.md.

## Cost Impact
License $0. Build cost internal (~3–4 wks). Avoids SurveyJS per-dev fees and EULA legal review entirely.

## Migration/Reversal Strategy
No SurveyJS to migrate. If RJSF blocks (Spike 1 fails): fall back to C (JSON Forms) reusing the canonical schema and Zod generator — swap is renderer-local behind `packages/renderer`. Accidental proprietary-schema import: quarantine under `x-vendor:*` + flag for review.

## Open Questions
RJSF v6 RSC story (keep renderer client-only for now); Conform vs raw RHF for server-actions path (spike, non-blocking). `ValidatorType` stub must be re-verified against the exact pinned v6 minor at IMPL start (15-minute check inside Spike 1); any v7 migration re-opens this ADR.
