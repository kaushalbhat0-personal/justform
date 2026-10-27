# FORMOS Canonical Form Schema (v1)

Framework-independent. Owned source of truth. JSON Schema / uiSchema / Zod are DERIVED — never hand-edited, never AI-edited directly.

## Top-level structure

```text
Form
 ├── metadata (id, key, title, description, localeDefault, owner)
 ├── schemaVersion (int) / rendererVersion (semver string)
 ├── settings (captcha, schedule, caps, uniqueKeys, saveContinue, offline)
 ├── themeRef
 ├── pages[] → sections[] → fields[]
 ├── rules[]
 ├── calculations[]
 ├── localization { locale: { i18nKey: string } }
 └── notificationsRef / integrationsRef (refs, not inline secrets)
```

## Field definition

```text
Field { id (uuid stable), key (slug stable), type (closed registry + x-*),
        label, description?, required, hidden?, disabled?,
        config (per-type), validation, default?, prefill?, visibility?, i18n? }
Validation { min/max/pattern/minLength/maxLength,
             file { maxMB, mime[] }?, custom [{ validatorId, params }]? }
Prefill { source: query | auth | integration, path }
```

Field types (closed registry, MVP subset in **bold**, full contract in FIELDS.md): **short_text, long_text, email, number, phone, dropdown, radio, checkbox, date, time, file, hidden** — MVP = 12 types (FIX-001: reduced from 15; anything needing side-effects, regulated trails, or complex layout is V1/V2). V1 adds: datetime, multiselect, rating, scale, matrix, address, signature, repeater, section_break, html. V2+ adds: payment, x-* promotions, conversational-turn widgets.

## Rules

```text
Condition { field (key), op: eq|neq|gt|gte|lt|lte|contains|not_contains|empty|not_empty|in|not_in, value? }
Rule { id, when: show|hide|require|set_value|skip_page, if: { all[] | any[] }, actions[] }
Action { target (key), kind: show|hide|require|optional|set|goto_page, value? }
```

AND/OR grouping supported. Evaluated by the owned interpreter client + server (same code, `packages/forms-engine`).

## Calculations

```text
Calc { id, target (key), expression, deps (keys[]) }
```

Expression subset only: `+ - * / % ( )`, numbers, `{{field_key}}` refs, fns `SUM AVG MIN MAX ROUND IF CONCAT DATE_DIFF`. No loops, no I/O, 1000-step cap, sandboxed (no `eval`).

## Stable IDs / keys / versions
- `id`: uuid v4/v7, immutable across versions, never reused. Renderer + submissions + PDF + analytics join by `id`.
- `key`: slug `[a-z0-9_]{1,64}`, unique per form, stable for API/analytics. Rename = explicit migration alias (`keyAliases: {old: new}`), never silent.
- Delete = tombstone (`deletedIds[]`); answers retained under old `id` for history.
- `schemaVersion`: int, canonical shape contract. Bump on breaking change; forward-only codemods in `packages/forms-engine/migrate`. Published versions immutable — never migrated in place; drafts auto-migrate on open.
- `rendererVersion`: renderer compatibility/build tag (semver of the RJSF/template pack + derivation build, e.g. `rjsf-6.11+drv9`). Informational; renderer must support `schemaVersion <= current`.
- `draftRevision` vs `publishedVersion`: the working Draft carries a mutable optimistic-concurrency `draftRevision` (see VERSIONING.md); publishing mints a new immutable `publishedVersion`. Never use bare `version_no` — always qualify.

## Compatibility
Unknown `type` or prop: ignore + flag in builder/preview validation report; respondent renderer logs and skips — never throws, never blocks unrelated fields.

## Extension mechanism
Custom types use the `x-` namespace (`x-nps`, `x-booking`). Registered in the widget registry: `{ type, widget, zodMapper, pdfMapper, a11yNotes }`. Promotion `x-*` → core requires an ADR + migrator. Vendor-proprietary props quarantined under `x-vendor:*`.

## Custom validators
Declared as `{ validatorId, params }` (e.g. `unique_email`, `ABN_check`, `no_profanity`). Registry maps id → `{ clientFn?, serverFn, messageKey }`. Server always re-runs with timeout.

## Example (contact, 3 fields + 1 rule)

```json
{"id":"f_1","key":"contact","schemaVersion":1,"rendererVersion":"rjsf-6",
"metadata":{"title":"Contact","localeDefault":"en"},"settings":{},
"themeRef":"brand-a","pages":[{"id":"p1","key":"main","title":"Main","sections":[
{"id":"s1","key":"s1","fields":[
{"id":"a1","key":"name","type":"short_text","label":"Name","required":true,"config":{},"validation":{"minLength":2}},
{"id":"a2","key":"email","type":"email","label":"Email","required":true,"config":{},"validation":{}},
{"id":"a3","key":"topic","type":"dropdown","label":"Topic","required":false,"config":{"options":["Support","Sales"]},"validation":{}}]}]}],
"rules":[{"id":"r1","when":"show","if":{"all":[{"field":"topic","op":"eq","value":"Support"}]},"actions":[{"target":"email","kind":"require"}]}],
"calculations":[],"localization":{},"notificationsRef":null,"integrationsRef":null}
```
