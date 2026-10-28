# FORMOS-IMPL-005 — Phase 4: Form Builder Foundation

## Scope

First real builder: open draft → palette → canvas → properties → reorder →
delete → undo/redo → autosave (OCC) → conflict handling → publish →
versions/republish. Not a full Jotform builder; no drag-and-drop, templates,
public URLs, submissions, or later modules.

## Architecture

- `packages/builder` (new, framework-agnostic): `capabilities.ts` (palette +
  property capability source derived from canonical MVP-12), `document.ts`
  (canonical add/edit/reorder/move/delete ops — new validated docs, generated
  ids/keys, tombstones, reference blockers, field-mapped validation),
  `history.ts` (bounded undo/redo over snapshots), `autosave.ts`
  (debounced controller with stale-response guards, conflict preservation,
  retry/reload).
- `apps/web/.../builder`: server page (read gate + `canEdit`), `BuilderShell`
  (editor state, toolbar, status, conflict UX, preview, publish), `FieldPalette`,
  `FormCanvas` (select/reorder/delete cards, keyboard, two-step delete),
  `FieldInspector` (capability-driven properties, options, constraints,
  version history + republish).
- No BuilderSchema: palette/property/canvas all consume the canonical
  document. No localStorage (G8). No new state/validation deps (G8).
  `@rjsf/*` stays inside `@formos/renderer` (G6 held — one type-only import
  caught and removed during implementation).

## Key behaviors

- Validation before save via `validateDocument`; invalid docs stay local with
  field-linked errors.
- Draft/revision authority stays server-side: autosave → `updateDraftAction`
  (OCC) → publish via `publishAction`; conflict (409 shape) preserves local
  edits with retry-on-latest / reload-server-version paths.
- Deletion of rule/calc-referenced fields is refused with blockers.
- Published snapshots are read-only in the builder.
- Preview renders the live doc through the renderer boundary with the Zod gate.

## Verification

- `packages/builder`: 26 tests (document/history/autosave/capabilities).
- Full `npm run ci`: typecheck, eslint, guards G1–G8, all suites, Next build.
- S1 criterion (e) closed in production: Turbopack resolves every static
  `@rjsf/core` barrel import, so the unaliased prod build failed on
  `@rjsf/validator-ajv8`; `apps/web/next.config.ts` now aliases it
  (turbopack + webpack) to the poisoned stub in `@formos/renderer`.
  Production bundle scan: the only `ajv` occurrence is the stub's own throw
  string — no AJV library ships.
- No migration (no DB changes); live re-verification not applicable — server
  boundary unchanged and live-proven in IMPL-004.

## Deferred

Drag-and-drop, templates, property editor polish (key rename, rule/calc UI),
builder collaboration, autosave tuning with real-device data, publish UX
polish, and all later modules.
