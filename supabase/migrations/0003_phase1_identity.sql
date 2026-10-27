-- FORMOS migration 0003 — Phase 1 identity/invitation control plane.
-- Adds ONLY what Phase 1 needs. No form/submission/workflow tables.
-- Follows 0001 conventions: portable SQL, pinned DEFINER, deny-by-default RLS.

-- ---------------------------------------------------------------- profiles self-provisioning
-- Authenticated users may create exactly their own profile row (id = auth.uid()).
-- No UPDATE/DELETE grants beyond the Phase-0 self policies (unchanged).
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT INSERT ON public.profiles TO authenticated;
CREATE POLICY profiles_self_insert ON public.profiles
  FOR INSERT TO PUBLIC WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------- invitation acceptance (RPC-only)
-- Token handling: the raw token NEVER persists. The API route hashes the
-- presented token (SHA-256, Node crypto) and calls this RPC with the hash.
-- Comparison is an exact match on 256-bit random values over a rate-limited
-- route — brute force is infeasible; misses return a uniform error (no oracle).
-- Email binding uses the JWT claim: (auth.jwt() ->> 'email') must equal the
-- invitation email, so a leaked hash alone cannot be redeemed by another user.
CREATE OR REPLACE FUNCTION formos.accept_invitation(p_token_hash TEXT, p_membership_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_email TEXT := auth.jwt() ->> 'email';
  v_inv public.invitations%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT * INTO v_inv FROM public.invitations i WHERE i.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid or expired invitation';
  END IF;
  IF v_inv.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid or expired invitation';
  END IF;
  IF v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'invalid or expired invitation';
  END IF;
  IF v_email IS NULL OR lower(v_email) != lower(v_inv.email) THEN
    RAISE EXCEPTION 'invitation email mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.workspace_id = v_inv.workspace_id AND m.user_id = v_user AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'already a member';
  END IF;
  INSERT INTO public.memberships (id, workspace_id, user_id, role)
  VALUES (p_membership_id, v_inv.workspace_id, v_user, v_inv.role);
  UPDATE public.invitations SET used_at = now() WHERE id = v_inv.id;
  RETURN v_inv.workspace_id;
END;
$$;

-- ---------------------------------------------------------------- member removal (RPC-only)
-- Admin/owner may remove active members except: self, owners (owner-only removal
-- arrives with the ownership-transfer flow in a later phase), and the last owner.
CREATE OR REPLACE FUNCTION formos.remove_member(p_workspace_id UUID, p_target_user UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_caller_role TEXT;
  v_target_role TEXT;
  v_owner_count INTEGER;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_target_user = v_caller THEN
    RAISE EXCEPTION 'self removal denied (use leave-workspace flow)';
  END IF;
  SELECT m.role INTO v_caller_role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = v_caller AND m.status = 'active';
  IF v_caller_role IS NULL OR formos.role_rank(v_caller_role) < 3 THEN
    RAISE EXCEPTION 'admin required';
  END IF;
  SELECT m.role INTO v_target_role FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = p_target_user AND m.status = 'active';
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'target membership not found';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'owner removal requires ownership transfer';
  END IF;
  SELECT count(*) INTO v_owner_count FROM public.memberships m
  WHERE m.workspace_id = p_workspace_id AND m.role = 'owner' AND m.status = 'active';
  IF v_owner_count < 1 THEN
    RAISE EXCEPTION 'workspace must retain an owner';
  END IF;
  DELETE FROM public.memberships
  WHERE workspace_id = p_workspace_id AND user_id = p_target_user;
END;
$$;
