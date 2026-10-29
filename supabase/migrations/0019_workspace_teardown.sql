-- FORMOS migration 0019 — authorized workspace teardown (IMPL-012).
--
-- Root cause (proven by IMPL-012 STEP-2 PGlite reproduction + live W10 probe):
-- every tenant table carries workspace_id ON DELETE CASCADE, so a workspace
-- DELETE cascades cleanly — except into form_versions / workflow_versions,
-- whose unconditional BEFORE UPDATE OR DELETE triggers raise ('...immutable')
-- and abort the whole transaction. No bypass context existed, and no
-- delete_workspace RPC existed (RLS denies all app-role workspace DELETE).
--
-- Design (tenant teardown, not version mutation):
--   1. form_versions / workflow_versions stay immutable for every ordinary
--      operation. The triggers keep raising for UPDATE always, and for DELETE
--      unless the row is being removed by the authorized teardown cascade.
--   2. formos.delete_workspace(p_workspace_id) is the ONLY path that can
--      establish the transaction-local teardown context
--      (app.formos_teardown_workspace, SET LOCAL = this transaction only).
--      No other RPC sets it, and raw SQL is unreachable from PostgREST, so
--      arbitrary clients cannot activate the bypass. Even with the context
--      set, version tables carry no DML grants/policies for app roles, so
--      only the cascade owned by this RPC's workspace DELETE can reach them.
--   3. Authorization mirrors the frozen matrix (workspace_admin.delete =
--      owner): authenticated callers must be the workspace owner; the
--      no-JWT path is service_role-only (maintenance), proven by the JWT
--      role claim per migration 0016 (current_user is unreliable in DEFINER).
--   4. One DELETE statement owns the atomicity: all 17 workspace FKs are
--      CASCADE, so teardown is all-or-nothing in a single transaction.
--      The GUC equality check is per-row defense: a cascade from workspace W
--      can only ever touch workspace_id = W rows.
--
-- Follows 0001 conventions: portable SQL, zero extensions, pinned-search_path
-- DEFINER, fully-qualified refs, strict types, no dynamic SQL.

-- ---------------------------------------------------------------- teardown context
-- Transaction-local deletion context. Returns the workspace UUID whose
-- teardown cascade is currently authorized, or NULL outside teardown.
CREATE OR REPLACE FUNCTION formos.teardown_context()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN v ~ '^[0-9a-fA-F-]{36}$' THEN v::UUID
    ELSE NULL
  END
  FROM (SELECT NULLIF(current_setting('app.formos_teardown_workspace', true), '') AS v) s;
$$;
REVOKE ALL ON FUNCTION formos.teardown_context() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- form_versions: teardown-aware immutability
-- UPDATE stays unconditionally rejected (teardown performs zero updates).
-- DELETE is allowed only for the row's own workspace teardown cascade.
CREATE OR REPLACE FUNCTION formos.prevent_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND formos.teardown_context() IS NOT DISTINCT FROM OLD.workspace_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'published versions are immutable (rollback = republish)';
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- workflow_versions: teardown-aware immutability
CREATE OR REPLACE FUNCTION formos.prevent_workflow_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND formos.teardown_context() IS NOT DISTINCT FROM OLD.workspace_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workflow versions are immutable';
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION formos.prevent_workflow_version_mutation() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- authorized teardown RPC
CREATE OR REPLACE FUNCTION formos.delete_workspace(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'workspace id is required';
  END IF;
  IF v_caller IS NOT NULL THEN
    -- Member path: workspace deletion is owner-only (workspace_admin.delete).
    IF formos.my_role(p_workspace_id) IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'workspace deletion requires workspace owner';
    END IF;
  ELSIF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    -- Trusted maintenance path is service-role only (migration 0016 idiom);
    -- anon and other roles hold no grant anyway (defense in depth).
    RAISE EXCEPTION 'authentication required';
  END IF;
  -- Establish the teardown context for THIS transaction only. The cascade
  -- below is the sole writer it authorizes (see trigger exemptions above).
  PERFORM set_config('app.formos_teardown_workspace', p_workspace_id::text, true);
  DELETE FROM public.workspaces WHERE id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace not found';
  END IF;
  RETURN jsonb_build_object('workspace_id', p_workspace_id, 'deleted', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.delete_workspace(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.delete_workspace(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION formos.delete_workspace(UUID) TO service_role;

-- ---------------------------------------------------------------- PostgREST-reachable wrapper (migration 0004 pattern)
-- Thin delegation: all authorization stays inside formos.delete_workspace.
CREATE OR REPLACE FUNCTION public.delete_workspace(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.delete_workspace(p_workspace_id);
$$;
REVOKE ALL ON FUNCTION public.delete_workspace(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_workspace(UUID) TO authenticated;
