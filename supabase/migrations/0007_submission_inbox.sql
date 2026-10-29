-- FORMOS migration 0007 — submission inbox foundation (Phase 7).
--
-- Adds the minimal lifecycle + authenticated read path for workspace members.
-- Writes stay RPC-only (intake RPC for inserts, set_submission_status RPC for
-- status); reads are direct RLS-gated SELECTs for builder+ (frozen matrix:
-- submission read floor = builder; update floor = data_collaborator).
-- Follows 0001 conventions: portable SQL, zero extensions, pinned-search_path
-- DEFINER, RLS deny-by-default + FORCE, app-generated UUIDs.
--
-- Member reads for the inbox (builder+ via RLS policy below). Writes stay
-- RPC-only: no INSERT/UPDATE/DELETE grant exists anywhere in this file.
GRANT SELECT ON public.submissions TO authenticated;

-- ---------------------------------------------------------------- status lifecycle
-- Minimal inbox lifecycle: new → read → archived (archive preferred over
-- destructive deletion; no delete path in this phase).
ALTER TABLE public.submissions
  ADD COLUMN status TEXT NOT NULL DEFAULT 'new'
  CHECK (status IN ('new', 'read', 'archived'));
ALTER TABLE public.submissions
  ADD COLUMN status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- List query shape: form scope + optional status + keyset order.
-- (Status is low-cardinality; filtering happens after the index scan.)
CREATE INDEX submissions_inbox_idx
  ON public.submissions (form_id, submitted_at DESC, id DESC);

-- ---------------------------------------------------------------- member reads
-- Frozen matrix (packages/domain authorization.ts): submission read floor is
-- builder — owner/admin/builder list + read. Weaker roles get zero rows here.
-- No INSERT/UPDATE/DELETE policies and no DML grants, ever.
GRANT SELECT ON public.submissions TO authenticated;
CREATE POLICY submissions_builder_read ON public.submissions
  FOR SELECT TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- status mutation RPC
-- Member-only status transitions (matrix update floor = data_collaborator).
-- Returns the previous status so the caller can audit {from, to} without a
-- separate read (data collaborators hold no SELECT grant). No payload is
-- ever returned or logged by this function.
CREATE OR REPLACE FUNCTION formos.set_submission_status(
  p_submission_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sub public.submissions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('new', 'read', 'archived') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;
  SELECT s.* INTO v_sub FROM public.submissions s WHERE s.id = p_submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_sub.workspace_id)) < 1 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_sub.status = p_status THEN
    RETURN jsonb_build_object('id', v_sub.id, 'status', v_sub.status, 'previous', v_sub.status, 'changed', false);
  END IF;
  UPDATE public.submissions
  SET status = p_status, status_changed_at = now()
  WHERE id = v_sub.id;
  RETURN jsonb_build_object('id', v_sub.id, 'status', p_status, 'previous', v_sub.status, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.set_submission_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.set_submission_status(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------- public wrapper (PostgREST surface)
-- Member-only control-plane wrapper, following the 0004/0005 pattern: thin
-- delegation to the frozen DEFINER implementation, least-privilege EXECUTE.
CREATE OR REPLACE FUNCTION public.set_submission_status(
  p_submission_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.set_submission_status(p_submission_id, p_status);
$$;
REVOKE ALL ON FUNCTION public.set_submission_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_submission_status(UUID, TEXT) TO authenticated;
