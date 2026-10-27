# FORMOS-IMPL-003 — Phase 2: S1/S2 Form-Engine Spikes (canonical schema + derivations)

## Scope

Proves the form-engine foundation. NOT the builder, renderer productionization,
publishing, submissions, or any Phase 3+ surface.

## What was built

- `@formos/forms-engine` (new implementation; was a reserved boundary README):
  canonical `schema.ts` (zero imports), `parse.ts` (parse → migrate → validate),
  `migrate.ts` (forward-only registry, frozen snapshots, content hashing),
  `jsonSchema.ts` / `uiSchema.ts` / `zod.ts` (deterministic derivations),
  `errors.ts` (stable `FormValidationError` + RJSF `ErrorSchema` adapter),
  `rules.ts` (condition evaluation, field-state resolution, cycle detection),
  `calculations.ts` (AST + pure bounded evaluator), `examples.ts` (spike fixture).
- `@formos/renderer` (new): ADR-003 boundary — the ONLY package importing
  `@rjsf/*`. Owns `formosValidator` (stub), `FormosForm` (Zod-gated shell),
  `FormosFileRefWidget` (registry extension proof).
- Guard G6: canonical purity, no executable-code surface, AJV-free prod deps,
  RJSF containment.

## S1 result

- RJSF 6.11.0 renders all MVP derivations under React 19 (zero peer/install errors).
- Validation bypass proven: stub `ValidatorType` + `noValidate`; RJSF alone
  submits invalid data (test), the Zod gate blocks it (`extraErrors` +
  `extraErrorsBlockSubmit`, error list + field errors render).
- Zod parity: one generator client+server; 1k-case agreement structural.
- Errors map to canonical field ids (incl. nested array paths).
- Show/hide churn demonstrated: engine `resolveFieldState` → filtered render.
- AJV: never imported by shipped code; prod deps AJV-free; core's only AJV
  touchpoint is the unused `getTestRegistry` helper in a `sideEffects:false`
  barrel (dropped by bundlers); test graph vendors it out via poisoned-stub alias.
- Interactive p75 <1.5s: no browser harness exists in this environment by design,
  so real-browser interaction was not measured. Closest [S] data points
  (jsdom, same RJSF 6.11 + React 19 code path): 13-field render ~94ms,
  103-field render ~164ms — two orders of magnitude inside the budget class.
  Real-device measurement belongs to the S5/Phase 5 device lab.
- RHF: NOT added (evidence in `packages/renderer/README.md`). Deferred to
  hand-tuned V1+ surfaces and the builder property editor.

## S2 result

- Canonical MVP-12 schema per FIELDS.md/FORM-SCHEMA.md (no residual
  contradiction: "15 types" was pre-FIX-001, resolved to 12).
- Discriminated field unions; stable ids/keys; options value/label split.
- Rules/calc ASTs: serializable, validated refs, cycle warnings, no code.
- Versioning: `schemaVersion` current=1; future rejected; frozen snapshots w/ hash.
- Perf [S]: 200-field derive (JSON+uiSchema) ×1000 → p50 0.22ms, p99 2.6ms
  (budget 25ms). Typical snapshot « 64KB.

## STOP-condition check

None triggered: RJSF renders; Zod covers MVP validation; canonical stays
renderer-independent; rules/calcs need no executable code; migration is
deterministic; field identity is stable; no frozen decision reversed
(RHF non-use is the explicitly permitted evidence-based outcome).

## Deferred

Builder, drag-and-drop, property editor, templates, publish UI, public form URL,
submission storage, inbox, analytics, tables, workflows, payments, AI,
PDF/signatures, integrations, file grant pipeline (widget placeholder only).
