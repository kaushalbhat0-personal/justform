-- FORMOS migration 0015 — quota reason refinement (Phase 10 follow-up).
--
-- Distinguishes "metered but unlimited" (ok) from "not metered at all"
-- (unmetered, e.g. storage_bytes) in check_quota's reason field. UI copy and
-- live assertions key off this; enforcement (allowed) is unchanged.

CREATE OR REPLACE FUNCTION formos.check_quota(p_workspace_id UUID, p_metric TEXT, p_quantity INTEGER DEFAULT 1)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan TEXT;
  v_anchor TIMESTAMPTZ;
  v_limit INTEGER;
  v_current INTEGER;
  v_period DATE;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('active_forms', 'monthly_submissions', 'monthly_api_requests', 'monthly_webhook_deliveries', 'storage_bytes') THEN
    RAISE EXCEPTION 'unknown metric';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'invalid quantity';
  END IF;
  SELECT w.plan, w.billing_period_start INTO v_plan, v_anchor FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  SELECT pl.limit_value INTO v_limit FROM public.plan_limits pl WHERE pl.plan = v_plan AND pl.metric = p_metric;
  IF NOT FOUND THEN
    SELECT pl.limit_value INTO v_limit FROM public.plan_limits pl WHERE pl.plan = 'free' AND pl.metric = p_metric;
  END IF;
  v_period := formos.period_start(v_anchor, now());
  IF p_metric = 'active_forms' THEN
    SELECT count(*)::int INTO v_current FROM public.forms f WHERE f.workspace_id = p_workspace_id AND f.status = 'active';
  ELSIF p_metric = 'storage_bytes' THEN
    v_current := NULL;
  ELSIF p_metric = 'monthly_submissions' THEN
    SELECT coalesce(sum(e.quantity), 0)::int INTO v_current FROM public.usage_events e
    WHERE e.workspace_id = p_workspace_id AND e.metric = 'submission' AND e.period_start = v_period;
  ELSIF p_metric = 'monthly_api_requests' THEN
    SELECT coalesce(sum(e.quantity), 0)::int INTO v_current FROM public.usage_events e
    WHERE e.workspace_id = p_workspace_id AND e.metric = 'api_request' AND e.period_start = v_period;
  ELSIF p_metric = 'monthly_webhook_deliveries' THEN
    SELECT coalesce(sum(e.quantity), 0)::int INTO v_current FROM public.usage_events e
    WHERE e.workspace_id = p_workspace_id AND e.metric = 'webhook_attempt' AND e.period_start = v_period;
  END IF;
  IF v_limit IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'metric', p_metric, 'current', v_current, 'limit', NULL,
      'remaining', NULL, 'period_start', v_period, 'reason', CASE WHEN v_current IS NULL THEN 'unmetered' ELSE 'ok' END);
  END IF;
  IF v_current IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'metric', p_metric, 'current', NULL, 'limit', v_limit,
      'remaining', NULL, 'period_start', v_period, 'reason', 'unmetered');
  END IF;
  IF v_current + p_quantity <= v_limit THEN
    RETURN jsonb_build_object('allowed', true, 'metric', p_metric, 'current', v_current, 'limit', v_limit,
      'remaining', v_limit - v_current, 'period_start', v_period, 'reason', 'ok');
  END IF;
  RETURN jsonb_build_object('allowed', false, 'metric', p_metric, 'current', v_current, 'limit', v_limit,
    'remaining', 0, 'period_start', v_period, 'reason', 'quota_exceeded');
END;
$$;
REVOKE ALL ON FUNCTION formos.check_quota(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.check_quota(UUID, TEXT, INTEGER) TO service_role;
