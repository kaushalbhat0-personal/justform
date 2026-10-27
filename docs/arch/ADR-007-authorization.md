# ADR-007 — Authorization (RBAC + Resource Grants)

## Status
DECIDED (accepted 2026-10-28).

## Context
Tenancy (ADR-006) gives isolation, not permission. Need least-privilege roles + per-resource sharing (e.g. share one form/table without workspace-admin) with deny-by-default, enforced server-side. Recon §7 confirmed the market gap: competitors gate real teams to Enterprise and lack native submission assignment.

## Decision
Workspace roles + per-resource grants. RLS checks membership/grant; RPCs/views enforce field-level redaction. **No authorization decision may depend solely on frontend state.**

### Workspace roles (fixed set, meanings versioned)
- **Owner:** billing + delete workspace. Anchors accountability. Min 1; transfer required before last-owner removal.
- **Admin:** manage members/integrations/API/billing-settings (not workspace delete). Delegates ops without ownership risk.
- **Builder:** create/edit forms, tables, workflows, integrations (scoped). Default maker role; cannot manage members/billing.
- **Data Collaborator:** submit + edit assigned submissions, comments/tags. Ops/data-entry without schema power.
- **Viewer:** read-only on shared resources + reports. Stakeholders/auditors; export only with explicit grant.

Future custom roles = data (`role_templates`), not hardcoded enums. MVP ships these 5 only.

### Resource grants (additive, expiring — RPC-minted ONLY)
`resource_grants(workspace_id, resource_type, resource_id, grantee_user_id, actions[], expires_at, created_by)`. Types: `form, table_view, workflow, report, integration, api_key_scope, billing_override`. Deny-by-default; grants additive except Viewer-cap; expiry mandatory for external shares. Field-level redaction (e.g. hide PII columns) enforced in **app layer via RPC/views** — RLS is the row gate, RPC is the column projector.

**Polymorphic-grant enforcement (PostgreSQL cannot FK to multiple tables — secured procedurally):** all app roles are DENIED direct INSERT/UPDATE on `resource_grants`; rows are created exclusively by the `create_grant` SECURITY DEFINER RPC, which validates inside one transaction: (1) target resource row EXISTS and is not soft-deleted; (2) target's `workspace_id` == grant's `workspace_id` (composite check — cross-workspace and nonexistent IDs rejected uniformly, no oracle); (3) inviter holds Admin+ (or Builder+ with share right on that resource) and `actions ⊆ inviter's own effective permissions` (no privilege invention, no self-escalation); (4) grantee is an active member of the same workspace (external shares use invitation-bound pending grants with expiry, never open bearer grants). Revocation is RPC-gated the same way. A scheduled orphan-sweep (referencing deleted/nonexistent resources, e.g. after hard retention purges) revokes stale grants + audits. RLS on `resource_grants` additionally constrains reads to same-workspace members so grant rows can never leak across tenants even if a bug mints one.

## Alternatives Considered
- **Pure role-based (no grants):** rejected — cannot share one form/table without widening workspace role; recreates the Enterprise-gating complaint.
- **Attribute-based (ABAC/departments) now:** rejected — power without users; adds policy-engine complexity pre-PMF. Deferred as future `role_templates` + attributes.
- **Per-column RLS:** rejected — RLS is row-oriented; per-column policies are brittle and slow. Redaction belongs in RPC/views.
- **Frontend-gated permissions:** rejected outright — client hints are UX only, never a control.

## Resource × action matrix (minimum role or explicit grant)

| Resource | Create | Read | Update | Delete | Share/Grant | Special |
|---|---|---|---|---|---|---|
| forms | Builder+ | member+grant | Builder+ | Builder+ (Admin+ if published) | Builder+ | publish needs Builder+; public link ≠ RLS bypass |
| submissions | intake RPC only (no anon/member direct write) | Builder+/assignee/grant | DataCollab+ (assigned) / Builder+ | Admin+ | Builder+ | export = explicit `export` grant + audit; intake is the hardened RPC (SUBMISSION-PIPELINE.md) |
| tables/views | Builder+ | member+grant | Builder+ | Builder+ | Builder+ | view-share may be Viewer-scoped |
| workflows (later) | Builder+ | Builder+ | Builder+ | Admin+ | Admin+ | run-as worker uses service-role, scoped payload |
| reports | Builder+ | grant/Viewer+ | Builder+ | Builder+ | Builder+ | scheduled runs redacted to grantee scope |
| integrations | Admin+ | Admin+/Builder(read) | Admin+ | Admin+ | Admin+ | secrets write-only, never readable post-create |
| api_keys | Admin+ | Admin+ (metadata only) | Admin+ (rotate/revoke) | Admin+ | — | scopes ⊆ creator perms; expiry ≤1y |
| billing | Owner/Admin | Owner/Admin | Owner | Owner (delete ws) | — | gateway-hosted only; no PAN in DB |
| workspace admin | — | Admin+ | Admin+ (members) | Owner | Admin+ | last-owner + self-demote blocked |

Viewer can never write, export, share, or manage members. Data Collaborator can never alter schema, integrations, API, or billing.

## Invitations
`workspace + email + role + 7d expiry + single-use token hash`. Only Admin+ may invite, never a role ≥ own. Accept binds `auth.uid()` email-match; uniform errors (no enumeration). No self-approve, no self-upgrade. Service-role never mints membership directly (break-glass RPC audited, disabled at MVP).

## Consequences
Slight RPC overhead on redacted reads — acceptable vs per-column RLS complexity. Grant sprawl risk mitigated by mandatory expiry + grant-list/revoke UI from day one.

## Security Impact
Every API route re-authorizes server-side. All denials sampled-logged; all grant/export/admin actions in `audit_log`. See RLS-THREAT-MODEL.md for T1–T10 + mandatory pre-MVP tests.

## Performance Impact
Membership/grant checks via `STABLE` helpers + ≤60s server cache, invalidated on role change. No per-row subquery storms.

## Cost Impact
$0 — policy code + RLS, no external PDP.

## Migration/Reversal Strategy
Roles versioned; custom `role_templates` added later without breaking the 5 fixed roles. Grant table additive — revocable per row.

## Open Questions
Department-scoped attributes post-MVP; just-in-time elevation (time-boxed Admin with approval flow).
