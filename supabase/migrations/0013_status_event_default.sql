-- FORMOS migration 0013 — default NULL for status-change event id (Phase 7/9 alignment).
--
-- 0008 retired the 2-arg set_submission_status overload to force an explicit
-- event decision, but p_event_id was already nullable-by-design ("callers
-- pass an app-generated event id, or NULL") and the BFF always passes one.
-- Existing callers (IMPL-007 live suite, member tooling) invoking the 2-arg
-- form broke with "function not found in schema cache". Give p_event_id a
-- DEFAULT NULL on both the control-plane function and its public wrapper so
-- the 2-arg call resolves again with identical auth semantics; event
-- emission stays opt-in per call, and the product path is unchanged (the BFF
-- always supplies an id). No table, grant, or policy changes.

CREATE OR REPLACE FUNCTION formos.set_submission_status(
  p_submission_id UUID,
  p_status TEXT,
  p_event_id UUID DEFAULT NULL
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
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.outbox
      (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
    VALUES
      (p_event_id, v_sub.workspace_id, 'submission.status_changed', 'submission', v_sub.id,
       jsonb_build_object(
         'submission_id', v_sub.id,
         'form_id', v_sub.form_id,
         'from', v_sub.status,
         'to', p_status,
         'changed_at', now()
       ));
  END IF;
  RETURN jsonb_build_object('id', v_sub.id, 'status', p_status, 'previous', v_sub.status, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.set_submission_status(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.set_submission_status(UUID, TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_submission_status(
  p_submission_id UUID,
  p_status TEXT,
  p_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.set_submission_status(p_submission_id, p_status, p_event_id);
$$;
REVOKE ALL ON FUNCTION public.set_submission_status(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_submission_status(UUID, TEXT, UUID) TO authenticated;
