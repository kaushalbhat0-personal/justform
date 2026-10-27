-- FORMOS migration 0002 — tenancy + authorization primitives (S3 spike scope).
--
-- Tables: profiles, workspaces, memberships, invitations (RLS only; accept flow = Phase 1),
--         resource_grants (RPC-minted only), audit_log (append-only).
-- Every statement follows 0001 conventions. Portable SQL: references auth.uid()
-- (provided by Supabase in prod; stubbed as app.test_user_id in PGlite tests —
-- the stub lives in test setup, NEVER in migrations).

-- ---------------------------------------------------------------- profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  tz TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;

CREATE POLICY profiles_self_read ON public.profiles
  FOR SELECT TO PUBLIC USING (id = auth.uid());
CREATE POLICY profiles_self_update ON public.profiles
  FOR UPDATE TO PUBLIC USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------- workspaces
CREATE TABLE public.workspaces (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  region TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();

-- ---------------------------------------------------------------- memberships
CREATE TABLE public.memberships (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'builder', 'data_collaborator', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON public.memberships (user_id);
CREATE INDEX memberships_workspace_idx ON public.memberships (workspace_id);
CREATE TRIGGER memberships_updated_at
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER memberships_workspace_immutable
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

-- ---------------------------------------------------------------- helpers
-- All helpers: SECURITY DEFINER, fixed search_path, STABLE, schema-qualified refs.
CREATE OR REPLACE FUNCTION formos.is_member(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION formos.my_role(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = auth.uid()
    AND m.status = 'active'
  LIMIT 1;
$$;

-- ---------------------------------------------------------------- workspace RLS
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspaces FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.workspaces TO authenticated;

CREATE POLICY workspaces_member_read ON public.workspaces
  FOR SELECT TO PUBLIC USING (formos.is_member(id));
-- Admin+ may rename; owner-only fields stay RPC-gated in later phases.
CREATE POLICY workspaces_admin_update ON public.workspaces
  FOR UPDATE TO PUBLIC
  USING (formos.my_role(id) IN ('owner', 'admin'))
  WITH CHECK (formos.my_role(id) IN ('owner', 'admin'));
-- No INSERT/DELETE policies: creation and deletion are RPC-only (deny by default).

-- ---------------------------------------------------------------- membership RLS
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.memberships FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.memberships TO authenticated;

-- Same-workspace members see non-sensitive columns (no tokens exist on this table).
CREATE POLICY memberships_member_read ON public.memberships
  FOR SELECT TO PUBLIC USING (formos.is_member(workspace_id));
-- No INSERT/UPDATE/DELETE policies: all membership writes are RPC-only.

-- ---------------------------------------------------------------- creation + role RPCs
-- Atomic workspace creation + owner membership (the ONLY workspace INSERT path).
-- All ids are generated app-side (UUIDv7) and passed in — the database never
-- invents identity (keeps migrations extension-free and portable).
CREATE OR REPLACE FUNCTION formos.create_workspace(p_id UUID, p_membership_id UUID, p_name TEXT, p_slug TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'name required';
  END IF;
  INSERT INTO public.workspaces (id, name, slug) VALUES (p_id, p_name, p_slug);
  INSERT INTO public.memberships (id, workspace_id, user_id, role)
  VALUES (p_membership_id, p_id, v_user, 'owner');
  RETURN p_id;
END;
$$;

-- Role rank lookup (owner > admin > builder > data_collaborator > viewer).
CREATE OR REPLACE FUNCTION formos.role_rank(p_role TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_role
    WHEN 'viewer' THEN 0
    WHEN 'data_collaborator' THEN 1
    WHEN 'builder' THEN 2
    WHEN 'admin' THEN 3
    WHEN 'owner' THEN 4
    ELSE -1
  END;
$$;

-- Admin-only role change. No self-target, no grant at-or-above own rank
-- (owner may grant owner — transfer flow arrives in Phase 1).
CREATE OR REPLACE FUNCTION formos.set_role(p_workspace_id UUID, p_target_user UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_target_user = v_caller THEN
    RAISE EXCEPTION 'self role change denied';
  END IF;
  SELECT m.role INTO v_caller_role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = v_caller AND m.status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not a member';
  END IF;
  IF formos.role_rank(v_caller_role) < 3 THEN
    RAISE EXCEPTION 'admin required';
  END IF;
  IF formos.role_rank(p_role) < 0 THEN
    RAISE EXCEPTION 'unknown role';
  END IF;
  IF formos.role_rank(p_role) >= formos.role_rank(v_caller_role)
     AND NOT (v_caller_role = 'owner' AND p_role = 'owner') THEN
    RAISE EXCEPTION 'cannot grant role at or above own rank';
  END IF;
  UPDATE public.memberships SET role = p_role, updated_at = now()
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target membership not found';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- invitations
-- Phase 0: table + RLS only. Accept/bind flow (token verification, expiry,
-- email match) arrives with Phase 1 identity work; the accept path WILL be
-- RPC-only per ADR-007.
CREATE TABLE public.invitations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'builder', 'data_collaborator', 'viewer')),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invitations_workspace_email_idx ON public.invitations (workspace_id, email);
CREATE TRIGGER invitations_updated_at
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER invitations_workspace_immutable
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.invitations FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.invitations TO authenticated;

-- Admin+ manage invites in their workspace (invite role rank enforced app-side
-- now, RPC-side with the accept flow in Phase 1).
CREATE POLICY invitations_admin_all ON public.invitations
  FOR ALL TO PUBLIC
  USING (formos.my_role(workspace_id) IN ('owner', 'admin'))
  WITH CHECK (formos.my_role(workspace_id) IN ('owner', 'admin'));

-- ---------------------------------------------------------------- resource_grants
-- RPC-minted ONLY: no INSERT/UPDATE/DELETE policies (deny by default).
CREATE TABLE public.resource_grants (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('form', 'table_view', 'workflow', 'report', 'integration', 'api_key_scope', 'billing_override')),
  resource_id UUID NOT NULL,
  grantee_user_id UUID NOT NULL,
  actions TEXT[] NOT NULL CHECK (array_length(actions, 1) > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX resource_grants_lookup_idx
  ON public.resource_grants (workspace_id, resource_type, resource_id);
CREATE INDEX resource_grants_grantee_idx ON public.resource_grants (grantee_user_id);
CREATE TRIGGER resource_grants_updated_at
  BEFORE UPDATE ON public.resource_grants
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER resource_grants_workspace_immutable
  BEFORE UPDATE ON public.resource_grants
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_grants FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.resource_grants FROM anon, authenticated;
GRANT SELECT ON public.resource_grants TO authenticated;

-- Members read grants in their workspace (own scope filtering is app-side;
-- grant rows never cross tenants thanks to workspace RLS).
CREATE POLICY resource_grants_member_read ON public.resource_grants
  FOR SELECT TO PUBLIC USING (formos.is_member(workspace_id));

-- Grant minting RPC: same-workspace, grantee-is-member, actions non-empty,
-- expiry required + future, inviter admin/owner, actions ⊆ inviter's power
-- (expressed as: non-admin resources need admin; Phase 2+ adds per-resource
-- existence checks alongside each resource table).
CREATE OR REPLACE FUNCTION formos.create_grant(
  p_id UUID, p_workspace_id UUID, p_resource_type TEXT, p_resource_id UUID,
  p_grantee UUID, p_actions TEXT[], p_expires_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT m.role INTO v_caller_role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = v_caller AND m.status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'not a member';
  END IF;
  IF formos.role_rank(v_caller_role) < 3 THEN
    RAISE EXCEPTION 'admin required to mint grants';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'expiry required and must be in the future';
  END IF;
  IF p_actions IS NULL OR array_length(p_actions, 1) IS NULL THEN
    RAISE EXCEPTION 'actions required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_grantee AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'grantee is not an active member';
  END IF;
  INSERT INTO public.resource_grants
    (id, workspace_id, resource_type, resource_id, grantee_user_id, actions, expires_at, created_by)
  VALUES (p_id, p_workspace_id, p_resource_type, p_resource_id, p_grantee, p_actions, p_expires_at, v_caller);
  RETURN p_id;
END;
$$;

-- Revocation RPC (admin/owner only; audited app-side in later phases).
CREATE OR REPLACE FUNCTION formos.revoke_grant(p_workspace_id UUID, p_grant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller_role TEXT;
BEGIN
  SELECT m.role INTO v_caller_role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.status = 'active';
  IF v_caller_role IS NULL OR formos.role_rank(v_caller_role) < 3 THEN
    RAISE EXCEPTION 'admin required';
  END IF;
  DELETE FROM public.resource_grants WHERE id = p_grant_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant not found';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- audit_log (append-only)
CREATE TABLE public.audit_log (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  actor_id UUID,
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'api_key', 'system')),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  diff JSONB,
  ip_hash TEXT,
  request_id TEXT,
  correlation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_workspace_time_idx ON public.audit_log (workspace_id, created_at DESC);
CREATE INDEX audit_log_resource_idx ON public.audit_log (resource_type, resource_id);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.audit_log TO authenticated;

-- Admin+ read own workspace trail. Members INSERT (producers move to RPC/worker
-- paths in later phases; no UPDATE/DELETE policy exists — EVER).
CREATE POLICY audit_log_admin_read ON public.audit_log
  FOR SELECT TO PUBLIC USING (formos.my_role(workspace_id) IN ('owner', 'admin'));
CREATE POLICY audit_log_member_insert ON public.audit_log
  FOR INSERT TO PUBLIC WITH CHECK (formos.is_member(workspace_id));
