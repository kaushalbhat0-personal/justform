# Database Logical Model v1 (no SQL — reconciled FIX-001)

Conventions: PK UUIDv7. Standard `created_at/updated_at/created_by`. RLS deny-by-default everywhere. Soft-delete app data; hard-delete only ephemeral/logs by retention. No SQL here — migrations land in `packages/database` in Phase 1+. Terminology follows VERSIONING.md (`draft_revision`, `published_version_no` — bare `version_no` banned).

## Tenant-column strategy (P0 reconciliation)
- **Rule 1 — explicit `workspace_id NOT NULL` on every first-class tenant table:** all tables below carry it EXCEPT the five join/log tables in Rule 2. Rationale: high-volume, security-sensitive, and directly-queried tables must be RLS-filterable without a join.
- **Rule 2 — inheritance (no `workspace_id`) ONLY for:** `submission_tags` (join), `status_history`, `integration_runs`, `webhook_deliveries`, `notification_log`, `report_runs`. Soundness proof, all required: (a) parent link FK is non-deferrable and non-nullable; (b) parent carries immutable `workspace_id` (Rule 3); (c) RLS policy joins the single parent (`... WHERE parent.workspace_id IN (my workspaces)`); (d) these rows are never addressed without their parent id in any API/route. Composite-FK discipline: wherever both parent and child carry `workspace_id`, the FK is composite `(workspace_id, parent_id)` so cross-workspace linkage is structurally impossible.
- **Rule 3 — `workspace_id` is IMMUTABLE.** No role, RPC, or worker may UPDATE it (enforced by trigger + `WITH CHECK`). Cross-workspace "move" = clone operation (new ids, new `workspace_id`), never re-parent. This is what makes Rule 2 joins sound over time.
- **Rule 4 — writes:** memberships, grants, invitations, versions (insert), audit, counters, and ALL anonymous intake go through RPCs/workers only. Grants are minted exclusively by the grant RPC (ADR-007). Anonymous callers hold no table grants at all (SUBMISSION-PIPELINE.md).

## Entities
- **profiles:** mirror of auth user. `id (=auth.uid), email, display_name, avatar_url, tz`. Idx `email`. Tenant: global (no workspace_id); RLS self-read/self-limited-write. Delete: hard only on account erase. Audit: no.
- **workspaces:** tenant root. `name, slug (unique), region, plan, status`. Idx `slug`. Lifecycle: creation RPC + Owner membership. RLS member-read / Admin-write / Owner-delete. Delete: soft → 30d purge. Audit: yes.
- **memberships:** `workspace_id, user_id (unique together), role, status`. Idx `(workspace_id, user_id), (user_id)`. Lifecycle: invite-accept only. RLS: same-workspace member limited read; writes RPC-only. Delete: hard on remove (audit retained). Audit: yes.
- **invitations:** `workspace_id, email, role, token_hash, expires_at (7d), used_at`. Idx `(workspace_id, email), token_hash`. Single-use. RLS Admin+. Delete: hard after use+30d. Audit: yes (both outcomes).
- **resource_grants (+ role_templates future):** `workspace_id, resource_type, resource_id, grantee, actions[], expires_at, created_by`. Idx `(workspace_id, resource_type, resource_id), (grantee)`. Writes RPC-ONLY (grant RPC validates: resource exists, same `workspace_id`, not deleted, grantee is member, actions ⊆ inviter's own power — ADR-007). Delete: hard on revoke (audit). Audit: yes.
- **forms:** container. `workspace_id, title, slug (unique per ws), status (draft/published/archived)`. Idx `(workspace_id, slug) unique, (workspace_id, status)`. Delete: soft. Audit: yes.
- **form_drafts:** WIP. `workspace_id, form_id (unique), draft_revision, base_published_version, payload JSONB, saved_by`. Idx `(workspace_id, form_id)`. Composite FK `(workspace_id, form_id)`. Autosave bumps `draft_revision`; compacted on publish. RLS author/Builder+. Delete: hard on form delete/retention. Audit: light.
- **form_versions:** immutable snapshots. `workspace_id, form_id, published_version_no (unique per form), schema_snapshot JSONB, schemaVersion, rendererVersion, hash, published_by`. Idx `(workspace_id, form_id, published_version_no)`. Insert-on-publish (RPC under advisory lock), never update/delete. RLS member-read / Builder+-insert. Audit: yes.
- **form_publications:** `workspace_id, form_id, channel (link/embed), publicId (unique), slug?, published_version_no, is_active, settings`. Idx `publicId`. Composite FK to versions `(workspace_id, form_id, published_version_no)`. Manage Builder+; public read via redacted RPC only if active. Delete: soft (deactivate). Audit: yes.
- **themes:** `workspace_id, name, tokens JSONB`. RLS member-read / Builder+-write. Delete: soft. Audit: no.
- **submissions:** response header. `workspace_id, form_id, published_version_no, schema_hash, answers JSONB, status, respondent_key, idempotency_key, assignee`. Idx `(workspace_id, form_id, submitted_at desc), (assignee), idempotency`. RLS Builder+/assignee/grant; NO anon table access (intake RPC only). Delete: soft (DSR hard on request). Audit: yes.
- **submission_index:** side index (capped fields/form). `workspace_id, submission_id, field_id, text_val/num_val/date_val`. Composite FK `(workspace_id, submission_id)`. Idx `(workspace_id, form_id, field_id, vals)` via parent join. Same RLS as submission; cascade with purge. Audit: no.
- **attachments:** `workspace_id, submission_id, field_id, storage_path, mime, bytes, scan_status`. Same RLS as submission; serve via minted URL. Delete soft→hard per retention. Audit: yes (sampled access).
- **assignments:** `workspace_id, submission_id, assignee, assigned_by, due_at, state`. Idx `(workspace_id, assignee, state)`. RLS member-read-scope / Builder+-manage. Delete hard on resolve+90d. Audit: yes.
- **status_history:** (Rule 2 — inherits via `submission_id`.) `submission_id, from, to, changed_by, at`. Append-only, never deleted. RLS via parent submission.
- **comments:** `workspace_id, submission_id, author, body, resolved`. Same RLS as submission. Soft delete. Audit: yes.
- **tags:** `workspace_id, name (unique per ws, citext)`. RLS member-read, DataCollab+ attach, Builder+ define. Audit: light.
- **submission_tags:** (Rule 2 — join.) `submission_id, tag_id, attached_by`. Composite FK to tags `(workspace_id, tag_id)` validated at attach RPC. Delete: hard on untag.
- **table_views:** `workspace_id, form_id, name, config JSONB, is_shared`. Grant-scoped read, Builder+ write. Soft delete. Audit: yes.
- **integrations:** `workspace_id, provider, config_enc, secret_ref (write-only), status`. Admin+ only. Delete soft (revoke). Audit: yes.
- **integration_runs:** (Rule 2 — inherits via `integration_id`.) `integration_id, trigger, status, attempt, payload_ref`. RLS via parent. Hard delete after 90d.
- **webhooks:** `workspace_id, url, events[], secret_ref (write-only), is_active, failures`. Admin+ only. Soft delete. Audit: yes.
- **webhook_deliveries:** (Rule 2 — inherits via `webhook_id`.) `webhook_id, event_id, status, attempts, next_retry`. RLS via parent. Hard delete after 30d.
- **api_keys:** `workspace_id, name, key_prefix (unique), key_hash, scopes[], expires_at, revoked_at`. Max 1y. Admin+ manage; runtime check server-side + binding enforced (API-WEBHOOKS.md). Hard delete on revoke+30d (audit retained). Audit: yes.
- **notifications:** `workspace_id, user_id, channel, template, status`. Self-read; enqueue via RPC. Hard delete after 90d. Audit: light.
- **notification_log:** (Rule 2 — inherits via `notification_id`.) attempts log. Hard delete after 90d.
- **reports:** `workspace_id, name, definition JSONB`. Grant-scoped, redacted to requester. Soft delete. Audit: yes.
- **report_runs:** (Rule 2 — inherits via `report_id`.) `report_id, status, output_ref, row_count`. Hard delete after 90d.
- **audit_log:** `workspace_id, actor, action, resource_type/id, diff JSONB, ip_hash, at`. Time-partitioned, append-only, retained ≥1y. Admin+ read; RPC/worker insert; never updated/deleted. Audit: self.
- **counters + usage_ledger:** `(workspace_id, metric, period_start, used, limit)` + immutable daily rollups. Member-read, worker/RPC-write. Hard delete after 13mo. Audit: no.
- **feature_flags:** `workspace_id (null = global), key, enabled, rules JSONB`. Member-read; Admin-manages workspace flags. Hard delete. Audit: yes.

Cross-cutting: FKs include `workspace_id` (composite) wherever both sides carry it. Attachments/report outputs live in private storage; DB holds refs only.
