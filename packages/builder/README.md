# @formos/builder — Builder foundation logic (Phase 5, framework-agnostic)

Owns the editor-side domain: canonical document operations, the field
capability registry, undo/redo history, and the autosave controller.
React shell lives in `apps/web/.../builder`. No React, RJSF, Supabase, or
`localStorage` here — persistence flows through the existing OCC server
boundary (`apps/web/lib/forms.ts`).

## Modules

| File | Owns |
|---|---|
| `capabilities.ts` | Palette + property-editor capability source, derived from canonical MVP-12. |
| `document.ts` | Canonical doc ops: add/edit/reorder/move/delete + tombstones + reference blockers + `validateDocument` (parse errors mapped to field ids). All ops return new validated documents; ids/keys generated here, never client-chosen. |
| `history.ts` | Bounded undo/redo over document snapshots (editor concern; DB revisions are not history). |
| `autosave.ts` | Debounced save controller with stale-response guards, conflict preservation, and explicit retry/reload. |

## Rules

- The canonical document is the only model — no BuilderSchema, no parallel field model.
- Deletion of referenced fields is refused with blockers (never silent corruption).
- Autosave never overwrites: stale base → 409 conflict → user chooses retry-on-latest or reload.
- Validation runs before every save; invalid docs stay local with field-mapped errors.
- Published snapshots are never written from the builder (read-only panels).
