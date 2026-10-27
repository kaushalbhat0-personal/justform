# @formos/renderer — RJSF Lives Here and ONLY Here (Phase 2 spike)

ADR-003 requires all RJSF imports wrapped behind a replaceable boundary.
No other package or app may import `@rjsf/*` directly (enforced by review;
the fallback renderer swap stays local to this package).

## What this package owns

- `formosValidator` — interface-conformant stub (`ValidatorType`): `noValidate`
  + stub means RJSF never judges data. No AJV anywhere (see below).
- `FormosForm` — the owned client-gate shell: renders derived JSON Schema +
  uiSchema, runs the generated Zod gate in `onSubmit`, feeds failures to
  `extraErrors` (+`extraErrorsBlockSubmit`, `showErrorList`, `focusOnFirstError`),
  delivers normalized values on success.
- `FormosFileRefWidget` — proof of the widget-registry extension point
  (grant-flow placeholder for MVP file refs; Phase 6 builds the pipeline).

## AJV vendor-out (S1 criterion e)

`@rjsf/core`'s barrel statically imports `@rjsf/validator-ajv8` solely for its
`getTestRegistry` helper, which FORMOS never uses. Production bundlers drop
that dead export (`sideEffects: false` in `@rjsf/core`), so AJV never ships —
asserted structurally in `tests/s1.test.tsx` (no ajv in prod dependency trees
+ `sideEffects: false`). The vitest module graph aliases the specifier to a
poisoned stub (`tests/stubs/validator-ajv8.ts`): any actual use throws loudly.

## RHF decision (S1 — evidence-based, 2026-10-28)

**React Hook Form is NOT added for the S1 runtime, and MUST NOT be added
for schema-driven surfaces.** Evidence from this spike:

- RJSF already owns runtime form state (values, touched, dirty, per-field
  updates); layering RHF underneath adds a second state owner with no benefit.
- The submit gate needs only `validateSubmission` (pure function of values) —
  no resolver, no controller registration.
- RJSF controlled inputs re-render per keystroke at spike scale without issue;
  performance budgets (S5) are a Phase 5 concern with real measurements.
- Nested values/arrays: RJSF's `formData` object + canonical keys already give
  stable paths; RHF would duplicate the mapping (`zodIssuesToErrorSchema`
  already bridges Zod issues to field paths).

**Deferred, not rejected.** RHF's documented boundary (unchanged from ADR-003):

- Hand-tuned surfaces (payment, signature, matrix, conversational turns — V1+):
  RHF + Zod directly against the same generated Zod schema, no RJSF.
- Builder property editor (Phase 3+): RHF is the expected fit for a dense
  control-heavy editing surface (dirty/touched per control, uncontrolled
  inputs); re-evaluate with measurements then.

Adding `react-hook-form` as a dependency before those surfaces exist would
violate the dependency fence. Revisit only with evidence.
