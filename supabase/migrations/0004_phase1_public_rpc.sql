-- FORMOS migration 0004 — PostgREST-reachable RPC surface (Phase 1 live gate).
--
-- Root cause (found by the FORMOS-IMPL-002 live gate): the control-plane RPCs
-- live in the `formos` schema, which PostgREST does not expose (hosted API
-- serves `public` + `graphql_public` only). Direct SQL (`SELECT formos.*`)
-- works — which is why PGlite tests passed — but every PostgREST/RPC call
-- from `apps/web` and `scripts/verify/supabase-live.mjs` failed with
-- "Could not find the function public.<name> in the schema cache".
--
-- Fix (no redesign, no new authorization layer): thin `public` wrappers that
-- delegate 1:1 to the frozen `formos.*` implementations. All authorization,
-- validation, and error semantics stay inside `formos.*`; wrappers add no
-- logic, no tables, no policies, no extensions. Follows 0001 conventions:
-- SECURITY DEFINER + fixed `SET search_path = pg_catalog, pg_temp`,
-- fully-qualified delegation, strict types, no dynamic SQL.
-- Exposure is least-privilege: default PUBLIC execute is revoked and
-- EXECUTE is granted to `authenticated` only (every wrapper still raises
-- 'authentication required' for anonymous callers via auth.uid()).

-- ---------------------------------------------------------------- create_workspace
CREATE OR REPLACE FUNCTION public.create_workspace(p_id UUID, p_membership_id UUID, p_name TEXT, p_slug TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.create_workspace(p_id, p_membership_id, p_name, p_slug);
$$;
REVOKE ALL ON FUNCTION public.create_workspace(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace(UUID, UUID, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------- set_role
CREATE OR REPLACE FUNCTION public.set_role(p_workspace_id UUID, p_target_user UUID, p_role TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.set_role(p_workspace_id, p_target_user, p_role);
$$;
REVOKE ALL ON FUNCTION public.set_role(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_role(UUID, UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------- accept_invitation
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token_hash TEXT, p_membership_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.accept_invitation(p_token_hash, p_membership_id);
$$;
REVOKE ALL ON FUNCTION public.accept_invitation(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation(TEXT, UUID) TO authenticated;

-- ---------------------------------------------------------------- remove_member
CREATE OR REPLACE FUNCTION public.remove_member(p_workspace_id UUID, p_target_user UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.remove_member(p_workspace_id, p_target_user);
$$;
REVOKE ALL ON FUNCTION public.remove_member(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------- create_grant
CREATE OR REPLACE FUNCTION public.create_grant(
  p_id UUID, p_workspace_id UUID, p_resource_type TEXT, p_resource_id UUID,
  p_grantee UUID, p_actions TEXT[], p_expires_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.create_grant(p_id, p_workspace_id, p_resource_type, p_resource_id, p_grantee, p_actions, p_expires_at);
$$;
REVOKE ALL ON FUNCTION public.create_grant(UUID, UUID, TEXT, UUID, UUID, TEXT[], TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_grant(UUID, UUID, TEXT, UUID, UUID, TEXT[], TIMESTAMPTZ) TO authenticated;

-- ---------------------------------------------------------------- revoke_grant
CREATE OR REPLACE FUNCTION public.revoke_grant(p_workspace_id UUID, p_grant_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.revoke_grant(p_workspace_id, p_grant_id);
$$;
REVOKE ALL ON FUNCTION public.revoke_grant(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_grant(UUID, UUID) TO authenticated;
