# @formos/forms-engine — BOUNDARY RESERVED (Phase 2+)

This package will own the canonical FORMOS schema (FORM-SCHEMA.md, FIELDS.md):

```text
canonical schema → generated Zod → derived JSON Schema / uiSchema → RJSF
```

Nothing is implemented in Phase 0 — intentionally. Establishing the package now
fixes the single source of truth location so Phase 2 does not create competing
schemas in components, routes, or repositories.

Rules (from ADR-003 + FIX-002):
- Canonical schema is the only hand-edited artifact; derivations are generated.
- RJSF receives a stub ValidatorType + `noValidate`; AJV stays out of the bundle.
- Zod is the sole validation authority (client RHF + API/BFF pre-RPC).
- Field registry is closed + `x-` extensions; unknown types ignore + flag.
