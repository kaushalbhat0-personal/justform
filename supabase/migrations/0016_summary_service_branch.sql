-- FORMOS migration 0016 — service-role branch fix for get_usage_summary.
--
-- Inside a SECURITY DEFINER function, current_user reports the function
-- OWNER, not the caller — so the trusted-path check always failed for the
-- service role. Use the JWT role claim (the reliable caller signal, same as
-- auth.uid()) instead. No other changes.

CREATE OR REPLACE FUNCTION formos.get_usage_summary(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan TEXT;
  v_status TEXT;
  v_anchor TIMESTAMPTZ;
  v_period DATE;
  v_forms INTEGER;
  v_subs INTEGER;
  v_api INTEGER;
  v_wh INTEGER;
  v_forms_limit INTEGER;
  v_subs_limit INTEGER;
  v_api_limit INTEGER;
  v_wh_limit INTEGER;
  v_caller UUID := auth.uid();
BEGIN
  SELECT w.plan, w.billing_status, w.billing_period_start INTO v_plan, v_status, v_anchor
  FROM public.workspaces w WHERE w.id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF v_caller IS NOT NULL THEN
    IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSIF coalesce(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  v_period := formos.period_start(v_anchor, now());
  SELECT count(*)::int INTO v_forms FROM public.forms f WHERE f.workspace_id = p_workspace_id AND f.status = 'active';
  SELECT coalesce(sum(e.quantity), 0)::int INTO v_subs FROM public.usage_events e
  WHERE e.workspace_id = p_workspace_id AND e.metric = 'submission' AND e.period_start = v_period;
  SELECT coalesce(sum(e.quantity), 0)::int INTO v_api FROM public.usage_events e
  WHERE e.workspace_id = p_workspace_id AND e.metric = 'api_request' AND e.period_start = v_period;
  SELECT coalesce(sum(e.quantity), 0)::int INTO v_wh FROM public.usage_events e
  WHERE e.workspace_id = p_workspace_id AND e.metric = 'webhook_attempt' AND e.period_start = v_period;
  SELECT pl.limit_value INTO v_forms_limit FROM public.plan_limits pl
  WHERE pl.plan = coalesce((SELECT w.plan FROM public.workspaces w WHERE w.id = p_workspace_id AND w.plan IN ('free', 'pro', 'business')), 'free') AND pl.metric = 'active_forms';
  SELECT pl.limit_value INTO v_subs_limit FROM public.plan_limits pl
  WHERE pl.plan = coalesce((SELECT w.plan FROM public.workspaces w WHERE w.id = p_workspace_id AND w.plan IN ('free', 'pro', 'business')), 'free') AND pl.metric = 'monthly_submissions';
  SELECT pl.limit_value INTO v_api_limit FROM public.plan_limits pl
  WHERE pl.plan = coalesce((SELECT w.plan FROM public.workspaces w WHERE w.id = p_workspace_id AND w.plan IN ('free', 'pro', 'business')), 'free') AND pl.metric = 'monthly_api_requests';
  SELECT pl.limit_value INTO v_wh_limit FROM public.plan_limits pl
  WHERE pl.plan = coalesce((SELECT w.plan FROM public.workspaces w WHERE w.id = p_workspace_id AND w.plan IN ('free', 'pro', 'business')), 'free') AND pl.metric = 'monthly_webhook_deliveries';
  RETURN jsonb_build_object(
    'plan', v_plan,
    'billing_status', v_status,
    'period_start', v_period,
    'period_end', (v_period + INTERVAL '1 month - 1 day')::date,
    'metrics', jsonb_build_object(
      'active_forms', jsonb_build_object('used', v_forms, 'limit', v_forms_limit,
        'remaining', CASE WHEN v_forms_limit IS NULL THEN NULL ELSE greatest(v_forms_limit - v_forms, 0) END),
      'monthly_submissions', jsonb_build_object('used', v_subs, 'limit', v_subs_limit,
        'remaining', CASE WHEN v_subs_limit IS NULL THEN NULL ELSE greatest(v_subs_limit - v_subs, 0) END),
      'monthly_api_requests', jsonb_build_object('used', v_api, 'limit', v_api_limit,
        'remaining', CASE WHEN v_api_limit IS NULL THEN NULL ELSE greatest(v_api_limit - v_api, 0) END),
      'monthly_webhook_deliveries', jsonb_build_object('used', v_wh, 'limit', v_wh_limit,
        'remaining', CASE WHEN v_wh_limit IS NULL THEN NULL ELSE greatest(v_wh_limit - v_wh, 0) END),
      'storage_bytes', jsonb_build_object('used', NULL, 'limit', NULL, 'remaining', NULL, 'metered', false)
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION formos.get_usage_summary(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.get_usage_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION formos.get_usage_summary(UUID) TO service_role;
