# Immutable Form Versioning (reconciled — FIX-001)

Four version terms. They are NOT interchangeable. `version_no` as a bare name is banned from new code/docs; always qualify.

## The four terms

| Term | What it is | Mutability | Example |
|---|---|---|---|
| `schemaVersion` | Canonical schema **contract** (int). Bump only on breaking canonical-shape changes; migrators `migrate(vN→vN+1)` required | Evolves via ADR + migrator, never silently | `1` → `2` |
| `draftRevision` | Mutable working-copy **optimistic-concurrency counter** on the single Draft per Form (`rev` int, starts 1, +1 per saved patch batch) | Mutable, monotonic per draft | `rev 14` |
| `publishedVersion` | Immutable published snapshot **number** (`1, 2, 3…`, monotonic per form) | **Immutable forever** | `v3` |
| `rendererVersion` | Renderer **compatibility/build tag** (semver of the RJSF/template pack + derivation build, e.g. `rjsf-6.11+drv9`) | Informational; renderer must support `schemaVersion <= current` | `rjsf-6.11+drv9` |

Storage mapping: `form_drafts (form_id PK, payload, draft_revision, base_published_version)`; `form_versions (form_id, published_version_no PK-part, schema_snapshot, schemaVersion, rendererVersion, hash, published_by/at, changelog)`; `form_publications (…, published_version_no, …)`. Submissions pin `(form_id, published_version_no, schema_hash)`.

## Lifecycle rules (normative)
- **Draft:** exactly one mutable row per Form. Autosave writes patches; each committed batch bumps `draftRevision`. Concurrent builder sessions use optimistic concurrency: `PATCH {base_draft_revision, ops[]}` → mismatch ⇒ 409 + fresh snapshot + toast (see REALTIME.md locks). Exactly one Draft; never two, never none while Form exists.
- **Publish:** validate Draft (schema valid, migration clean, Zod generation succeeds) → freeze snapshot → INSERT `form_versions` (`publishedVersion = max+1`) under advisory lock on `form_id` → repoint default Publication → emit `form.published`. Draft survives (keeps `draftRevision`, records `base_published_version`).
- **Rollback = republish.** Republishing `publishedVersion N-1` creates `N+1` with a snapshot copy of N-1 + `changelog: rollback to N-1`. History append-only; nothing is ever restored in place.
- **Unpublish:** Publication `is_active=false` (renders 410); versions untouched; republish resumes numbering.
- **Clone:** new `form_id`; field `id`s preserved **within the new form's namespace** (fresh form scope, same ids allowed since all joins are `(form_id, field_id)`); integration refs carried **without secrets** (`needs_reauth`, publish blocked until re-auth); submission history never cloned.
- **Migration:** forward-only codemods in `packages/forms-engine/migrate`. A Draft opened on older `schemaVersion` auto-migrates (bumps `draftRevision`, never `publishedVersion`). Published versions are never migrated in place. AI edits Drafts only and must pass the same gate as humans.
- **Comparison/diff:** version compare = diff of two `schema_snapshot`s (`publishedVersion A` vs `B`, or Draft vs `base_published_version`); changelog required on publish.
- **Old-submission rendering:** inbox/PDF/export of a submission always uses **its pinned snapshot**, never current.

## Rules carried forward (unchanged)
Published is immutable — no mutation, hotfix = new version. Templates = version-snapshot forks seeding Drafts. Duplicate preserves integration field-mapping minus secrets. AI never writes FormVersion directly.
