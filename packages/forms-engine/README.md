# @formos/forms-engine — Canonical FORMOS Schema + Derivations (Phase 2)

Single source of truth for the form contract (FORM-SCHEMA.md, FIELDS.md).
One-way derivation only:

```text
canonical schema → JSON Schema → RJSF renderer
canonical schema → uiSchema     → RJSF renderer
canonical schema → Zod          → application validation (client + server)
```

Never reversed. Zod / JSON Schema / RJSF are derived artifacts, never inputs.

## Modules

| File | Owns |
|---|---|
| `schema.ts` | Canonical types. **Zero imports** — no React/RJSF/RHF/Zod/Next/Supabase/DB (enforced by G6). |
| `parse.ts` | Parse → migrate → validate unknown input into `CanonicalForm` (strict shape + semantic checks: unique ids/keys, resolvable refs, consistent ranges, deps match). |
| `migrate.ts` | Version registry (forward-only codemods; v1 genesis), deterministic `stableStringify`, `hashCanonical`, frozen `createPublishedSnapshot`. |
| `jsonSchema.ts` | Draft-07 derivation. Simple constructs only — no `anyOf`/`oneOf`/`$ref`/conditionals (lint-asserted in tests). |
| `uiSchema.ts` | Widget/presentation derivation (`ui:order` follows document order). |
| `zod.ts` | Application Zod generator + `validateSubmission` (client gate and server pre-RPC share this function). Normalizes: defaults fill, phone formatting stripped, untouched optionals collapse `""` → undefined. |
| `errors.ts` | `FormValidationError` (stable `fieldId`/`key`/code) + `zodIssuesToErrorSchema` (RJSF `ErrorSchema` for `extraErrors`). Library error objects are translated, never copied. |
| `rules.ts` | Condition evaluation, `resolveFieldState` (visible/required per key), reference validation + conservative cycle detection (report, never loop). |
| `calculations.ts` | Serialized AST (`CalcNode`) + pure bounded evaluator (1000-step cap, total errors, topological order, cycles → per-calc errors). No `eval`, no `new Function` (G6). |
| `examples.ts` | Spike fixture (contact/intake form). Test/fixture use, not a product form. |

## Rules

- Canonical schema is the only hand-edited artifact; derivations regenerate.
- Published snapshots are deep-frozen; rollback = republish, never edit.
- Unknown `x-` types ride through opaquely; unknown non-`x-` types are rejected.
- Day-boundary caveat: `notPast`/`notFuture` compare against the UTC calendar day.
- File values are attachment-ID refs (`string[]`); the grant pipeline is Phase 6.
