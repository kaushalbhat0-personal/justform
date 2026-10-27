# Canonical Field Registry — MVP-12 + V1 + V2 (FIX-001)

One canonical list. Earlier references to "15 MVP field types" are superseded: **MVP = 12 field types**, not 15. Twelve is architecturally better — every MVP type is validatable offline, storable in JSONB without side tables, and renderable as an RJSF island with no validator-dependent schema constructs. Anything needing side-effects (payment), regulated trails (signature), or complex layout moves to V1/V2. All document counts updated accordingly.

Conventions per type: canonical `type` name · stored value shape (JSON) · validation surface · RJSF widget (derived JSON Schema fragment) · generated Zod · a11y contract · server-safe (yes = pure data, no side effects) · storage note.

## MVP — 12 types (IN)

| # | type | value shape | validation | JSON Schema (derived) | Zod (generated) | widget | a11y | server-safe | storage |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `short_text` | `string` | min/maxLength, pattern | `{type:'string',minLength,maxLength,pattern}` | `z.string().min().max().regex()` | text input | label + inline error + `aria-describedby` | yes | JSONB |
| 2 | `long_text` | `string` | min/maxLength | `{type:'string',maxLength}` (+ `ui:widget:'textarea'`) | `z.string().max()` | textarea | same + character count announced | yes | JSONB |
| 3 | `email` | `string` | format email (+ optional MX/verify at V1) | `{type:'string',format:'email'}` | `z.string().email()` | email input (`autocomplete=email`) | same | yes | JSONB |
| 4 | `number` | `number` | min/max, integer flag | `{type:'number'|'integer',minimum,maximum}` | `z.number().min().max()` / `z.int()` | numeric input (`inputmode=decimal`) | same + range announced | yes | JSONB (num side-index eligible) |
| 5 | `phone` | `string (E.164-normalized server-side)` | region-aware pattern (formats registry) | `{type:'string',pattern}` | `z.string().regex(phone)` + normalize transform | tel input (`autocomplete=tel`) | same | yes | JSONB |
| 6 | `dropdown` | `string` (option value) | `enum` closed set | `{type:'string',enum:[…]}` | `z.enum([...])` | select | listbox semantics, keyboard-native | yes | JSONB |
| 7 | `radio` | `string` (option value) | `enum` closed set | `{type:'string',enum}` (+ `ui:widget:'radio'`) | `z.enum([...])` | radiogroup | native radio group | yes | JSONB |
| 8 | `checkbox` | `string[]` (checked values) | min/maxItems, subset of options | `{type:'array',items:{enum},minItems}` | `z.array(z.enum()).min().max()` | checkbox group | group label + per-option labels | yes | JSONB |
| 9 | `date` | `string (YYYY-MM-DD)` | range, not-past/future flags | `{type:'string',format:'date',min,max}` | `z.string().date().refine(range)` | date input (native, custom later) | native picker announced | yes | JSONB (date side-index eligible) |
| 10 | `time` | `string (HH:MM)` | range | `{type:'string',pattern:'^\\d{2}:\\d{2}$'}` | `z.string().regex(time)` | time input | native picker announced | yes | JSONB |
| 11 | `file` | `{attachment_ids:string[]}` refs only | maxMB, MIME allowlist, maxCount | `{type:'array',items:{type:'string',format:'uuid'}}` (refs, never bytes) | `z.array(z.string().uuid()).max(count)` + server grant/scan re-check | upload widget (grant flow) | progress + status announced (G4) | **no** (grant + AV + quarantine) | **relational `attachments` rows; refs in JSONB** |
| 12 | `hidden` | `string` | none (server-trusted only if allowlisted source) | `{type:'string'}` (+ `ui:widget:'hidden'`) | `z.string().optional()` | hidden | never focusable, excluded from SR | **conditional** (URL-prefill allowlist; never user-editable) | JSONB |

All MVP types: derived JSON Schema uses **only** draft-07 simple constructs (no `anyOf`/`oneOf`/`$ref`/`if-then-else` at render — see ADR-003 constraint); conditional behavior lives in FORMOS rules interpreted by our engine, not in schema conditionals.

## V1 — add (needs Phase 8+ or regulated review)
`datetime` · `multiselect` (async options w/ server-checked allowlist) · `rating` (`integer 1–N`, radiogroup-star a11y) · `scale` · `matrix` (rows×cols enum grid, keyed sub-answers) · `address` (structured object, per-subfield validation) · `section_break`/`html` (presentational, never submitted) · `signature` (drawn-image → file pipeline + intent statement; e-sign **trail** stays V2) · repeated-section (`repeater` array-of-object, cap 50) · server-verified email/phone (OTP-gated).

## V2+ — add (deferred with their modules)
`payment` (gateway Elements only; needs ADR-028) · `x-nps`, `x-booking` (promote via ADR + migrator) · conversational-turn widgets (projection of canonical, not new storage) · AI-suggested options (needs ADR-031).

## Change control
New type = registry entry + derivation + Zod mapper + widget + a11y notes + migrator note (MVP→V1 types ship as `x-*` first if needed pre-promotion). Promotion `x-*` → core requires ADR.
