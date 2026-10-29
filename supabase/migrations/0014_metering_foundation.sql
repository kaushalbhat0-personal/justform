-- FORMOS migration 0014 — usage metering + billing foundation (Phase 10, metering-only).
--
-- No payments, no providers, no financial ledger. This creates the metering
-- substrate a later billing integration can map to:
--   workspace billing metadata (plan exists; + period anchor + status)
--   plan_limits (data, not conditionals; NULL = unlimited)
--   usage_events (idempotent ledger; UNIQUE(workspace, metric, source, source_id))
--   period/quota/summary control plane (single entitlement boundary)
--   intake + delivery metering wired into the existing transactions
--   plan fields locked against direct browser writes (column-level grants)
--   api_keys gains the read-only billing:read scope
--
-- Metric namespaces (explicit mapping, counted once each):
--   quota metric              <- usage_events.metric <- source
--   active_forms              <- forms table state (no events; BFF-enforced)
--   monthly_submissions       <- submission         <- intake txn (atomic)
--   monthly_api_requests      <- api_request        <- v1 boundary (post-success)
--   monthly_webhook_deliveries<- webhook_attempt    <- tick record (per attempt:
--                                                     initial + retry = 2)
--   storage_bytes             <- unmetered (no file-metadata source exists)

-- ---------------------------------------------------------------- workspace billing metadata
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS billing_period_start TIMESTAMPTZ;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active';

-- Plan fields are server-managed: admins may still rename (name/slug), but
-- plan/billing columns are no longer directly writable (M7). No product code
-- updates workspaces rows today; rename flows keep working unchanged.
REVOKE ALL ON public.workspaces FROM anon, authenticated;
GRANT SELECT ON public.workspaces TO authenticated;
GRANT UPDATE (name, slug) ON public.workspaces TO authenticated;

-- ---------------------------------------------------------------- plan limits (data)
CREATE TABLE public.plan_limits (
  plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'business')),
  metric TEXT NOT NULL CHECK (metric IN ('active_forms', 'monthly_submissions', 'monthly_api_requests', 'monthly_webhook_deliveries', 'storage_bytes')),
  -- NULL = unlimited for this plan/metric.
  limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
  PRIMARY KEY (plan, metric)
);
INSERT INTO public.plan_limits (plan, metric, limit_value) VALUES
  ('free', 'active_forms', 5),
  ('free', 'monthly_submissions', 100),
  ('free', 'monthly_api_requests', 1000),
  ('free', 'monthly_webhook_deliveries', 1000),
  ('free', 'storage_bytes', NULL),
  ('pro', 'active_forms', 50),
  ('pro', 'monthly_submissions', 10000),
  ('pro', 'monthly_api_requests', 100000),
  ('pro', 'monthly_webhook_deliveries', 100000),
  ('pro', 'storage_bytes', NULL),
  ('business', 'active_forms', NULL),
  ('business', 'monthly_submissions', NULL),
  ('business', 'monthly_api_requests', NULL),
  ('business', 'monthly_webhook_deliveries', NULL),
  ('business', 'storage_bytes', NULL);

ALTER TABLE public.plan_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_limits FROM anon, authenticated;
-- No policies, no grants: readable only through the quota/summary RPCs.

-- ---------------------------------------------------------------- usage events (idempotent ledger)
CREATE TABLE public.usage_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('submission', 'api_request', 'webhook_attempt')),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Authoritative source of the counted operation.
  source TEXT NOT NULL CHECK (source IN ('intake', 'api', 'tick')),
  -- Stable source identifier: submission id | request id | delivery_id:attempt.
  source_id TEXT NOT NULL,
  -- Denormalized period bucket (single source: period_start()).
  period_start DATE NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Double-count protection: retries/replays land here at most once.
  UNIQUE (workspace_id, metric, source, source_id)
);
CREATE INDEX usage_events_period_idx ON public.usage_events (workspace_id, metric, period_start);
CREATE INDEX usage_events_workspace_idx ON public.usage_events (workspace_id);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.usage_events FROM anon, authenticated;
-- No policies, no grants: writes flow through record_usage (trusted path) or
-- the intake/delivery transactions; reads flow through get_usage_summary.

-- ---------------------------------------------------------------- billing period
-- Deterministic monthly periods (UTC dates). No anchor (free default) means
-- calendar months; a workspace anchor shifts to monthly anniversaries with
-- month-end clamping (Jan 31 -> Feb 28). Pure function, unit-tested.
CREATE OR REPLACE FUNCTION formos.period_start(p_anchor TIMESTAMPTZ, p_now TIMESTAMPTZ)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_anchor IS NULL THEN (date_trunc('month', p_now))::date
    WHEN p_anchor > p_now THEN (p_anchor)::date
    ELSE (
      WITH k AS (
        SELECT ((EXTRACT(YEAR FROM p_now) - EXTRACT(YEAR FROM p_anchor)) * 12
          + (EXTRACT(MONTH FROM p_now) - EXTRACT(MONTH FROM p_anchor)))::int
          - CASE WHEN EXTRACT(DAY FROM p_now) < EXTRACT(DAY FROM p_anchor) THEN 1 ELSE 0 END AS n
      )
      SELECT CASE
        WHEN ((date_trunc('day', p_anchor) + (SELECT n FROM k) * INTERVAL '1 month')) > p_now
        THEN ((date_trunc('day', p_anchor) + ((SELECT n FROM k) - 1) * INTERVAL '1 month'))::date
        ELSE ((date_trunc('day', p_anchor) + (SELECT n FROM k) * INTERVAL '1 month'))::date
      END
    )
  END
$$;
REVOKE ALL ON FUNCTION formos.period_start(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- quota evaluation (single boundary)
-- Trusted-server-path only (no auth check): reachable by service_role and by
-- nested DEFINER calls (intake/tick run as owner). No public-schema exposure
-- beyond the service_role-only wrapper below.
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
  -- Unknown/legacy plan values fall back to free (documented; fail-safe direction is allow+meter, never silent block).
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

-- Member-facing quota probe (any active member; verdict only, no bypass).
-- Used by BFF enforcement where the caller holds a user session, not the
-- service key (e.g. form creation). Auth + membership are re-verified here.
CREATE OR REPLACE FUNCTION formos.check_quota_member(p_workspace_id UUID, p_metric TEXT, p_quantity INTEGER DEFAULT 1)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF formos.role_rank(formos.my_role(p_workspace_id)) < 0 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN formos.check_quota(p_workspace_id, p_metric, coalesce(p_quantity, 1));
END;
$$;
REVOKE ALL ON FUNCTION formos.check_quota_member(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.check_quota_member(UUID, TEXT, INTEGER) TO authenticated;

-- ---------------------------------------------------------------- usage recording (trusted path)
CREATE OR REPLACE FUNCTION formos.record_usage(
  p_workspace_id UUID,
  p_metric TEXT,
  p_source TEXT,
  p_source_id TEXT,
  p_quantity INTEGER DEFAULT 1,
  p_occurred_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_anchor TIMESTAMPTZ;
  v_period DATE;
BEGIN
  IF p_metric IS NULL OR p_metric NOT IN ('submission', 'api_request', 'webhook_attempt') THEN
    RAISE EXCEPTION 'unknown metric';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('intake', 'api', 'tick') THEN
    RAISE EXCEPTION 'unknown source';
  END IF;
  IF p_source_id IS NULL OR char_length(p_source_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid source id';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RAISE EXCEPTION 'invalid quantity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = p_workspace_id) THEN
    RAISE EXCEPTION 'not found';
  END IF;
  SELECT w.billing_period_start INTO v_anchor FROM public.workspaces w WHERE w.id = p_workspace_id;
  v_period := formos.period_start(v_anchor, coalesce(p_occurred_at, now()));
  BEGIN
    INSERT INTO public.usage_events (id, workspace_id, metric, quantity, source, source_id, period_start, occurred_at)
    VALUES (formos.new_uuid(), p_workspace_id, p_metric, p_quantity, p_source, p_source_id, v_period, coalesce(p_occurred_at, now()));
    RETURN jsonb_build_object('counted', true, 'period_start', v_period);
  EXCEPTION WHEN unique_violation THEN
    -- Already counted (replay/retry): at-most-once per source event.
    RETURN jsonb_build_object('counted', false, 'period_start', v_period);
  END;
END;
$$;
REVOKE ALL ON FUNCTION formos.record_usage(UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.record_usage(UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------- usage summary (member + service paths)
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
    -- Member path: billing read is admin-floor (owner/admin).
    IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
      RAISE EXCEPTION 'forbidden';
    END IF;
  ELSIF current_user <> 'service_role' THEN
    -- Trusted path is service-role only (API credential binding happens in
    -- the BFF before this call); anon and other roles hold no grant anyway.
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

-- ---------------------------------------------------------------- intake metering (atomic, in-transaction)
-- Quota gate runs before any write (denied work counts nothing); the usage
-- row commits atomically with submission + outbox. Idempotent replays return
-- the original receipt above the gate or land on the unique key once.
CREATE OR REPLACE FUNCTION formos.submit_submission(
  p_public_id TEXT,
  p_submission_id UUID,
  p_payload JSONB,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_pub public.form_publications%ROWTYPE;
  v_form public.forms%ROWTYPE;
  v_ver public.form_versions%ROWTYPE;
  v_existing UUID;
  v_count BIGINT;
  v_unique_key TEXT;
  v_unique_value TEXT;
  v_file_keys TEXT[];
  v_key TEXT;
  v_val JSONB;
  v_quota JSONB;
BEGIN
  IF p_public_id IS NULL OR p_public_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'not available';
  END IF;
  IF p_submission_id IS NULL THEN
    RAISE EXCEPTION 'invalid payload';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid payload';
  END IF;
  IF octet_length(p_payload::text) > 262144 THEN
    RAISE EXCEPTION 'payload too large';
  END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'invalid payload';
  END IF;

  SELECT p.* INTO v_pub FROM public.form_publications p
  WHERE p.public_id = p_public_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not available';
  END IF;
  SELECT f.* INTO v_form FROM public.forms f WHERE f.id = v_pub.form_id;
  IF NOT FOUND OR v_form.status <> 'active' OR NOT v_pub.is_active THEN
    RAISE EXCEPTION 'closed';
  END IF;
  SELECT v.* INTO v_ver FROM public.form_versions v WHERE v.id = v_pub.form_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'closed';
  END IF;
  IF v_pub.opens_at IS NOT NULL AND now() < v_pub.opens_at THEN
    RAISE EXCEPTION 'not open';
  END IF;
  IF v_pub.closes_at IS NOT NULL AND now() >= v_pub.closes_at THEN
    RAISE EXCEPTION 'closed';
  END IF;

  -- Workspace quota (metering boundary; denied work counts nothing and the
  -- 409 blends with the existing per-form cap semantics — no plan oracle).
  SELECT formos.check_quota(v_pub.workspace_id, 'monthly_submissions', 1) INTO v_quota;
  IF NOT coalesce((v_quota ->> 'allowed')::boolean, false) THEN
    RAISE EXCEPTION 'quota_exceeded:monthly_submissions';
  END IF;

  SELECT s.id INTO v_existing FROM public.submissions s
  WHERE s.publication_id = v_pub.id AND s.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('submission_id', v_existing, 'duplicate', true, 'status', 'received');
  END IF;

  IF v_pub.max_submissions IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.submissions s WHERE s.publication_id = v_pub.id;
    IF v_count >= v_pub.max_submissions THEN
      RAISE EXCEPTION 'limit reached';
    END IF;
  END IF;

  v_unique_key := v_pub.unique_field_key;
  IF v_unique_key IS NOT NULL THEN
    v_unique_value := NULLIF(trim(both from coalesce(p_payload ->> v_unique_key, '')), '');
    IF v_unique_value IS NULL THEN
      RAISE EXCEPTION 'invalid payload';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_pub.id::text || '|' || v_unique_key || '|' || v_unique_value, 0));
    PERFORM 1 FROM public.submissions s
    WHERE s.publication_id = v_pub.id AND s.payload ->> v_unique_key = v_unique_value
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'duplicate';
    END IF;
  END IF;

  SELECT coalesce(array_agg(f.key), '{}') INTO v_file_keys
  FROM (
    SELECT jsonb_path_query(v_ver.schema_snapshot, '$.pages[*].sections[*].fields[*]') AS field
  ) pages,
  LATERAL (
    SELECT pages.field ->> 'key' AS key
    WHERE pages.field ->> 'type' = 'file'
  ) f;
  IF v_file_keys IS NOT NULL THEN
    FOREACH v_key IN ARRAY v_file_keys LOOP
      v_val := p_payload -> v_key;
      IF v_val IS NOT NULL AND v_val <> 'null'::jsonb AND jsonb_array_length(coalesce(v_val, '[]'::jsonb)) > 0 THEN
        RAISE EXCEPTION 'attachments not available';
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.submissions
    (id, workspace_id, form_id, publication_id, form_version_id, payload, idempotency_key)
  VALUES
    (p_submission_id, v_pub.workspace_id, v_pub.form_id, v_pub.id, v_ver.id, p_payload, p_idempotency_key);

  INSERT INTO public.outbox
    (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES
    (p_submission_id, v_pub.workspace_id, 'submission.completed', 'submission', p_submission_id,
     jsonb_build_object(
       'submission_id', p_submission_id,
       'form_id', v_pub.form_id,
       'publication_id', v_pub.id,
       'published_version_no', v_ver.published_version_no,
       'received_at', now()
     ));

  -- Meter exactly one submission (same transaction; replays are absorbed by
  -- the receipt check above or by the unique key below — never double-count).
  INSERT INTO public.usage_events
    (id, workspace_id, metric, quantity, source, source_id, period_start)
  VALUES
    (formos.new_uuid(), v_pub.workspace_id, 'submission', 1, 'intake', p_submission_id::text,
     formos.period_start((SELECT w.billing_period_start FROM public.workspaces w WHERE w.id = v_pub.workspace_id), now()))
  ON CONFLICT (workspace_id, metric, source, source_id) DO NOTHING;

  RETURN jsonb_build_object('submission_id', p_submission_id, 'duplicate', false, 'status', 'received');
END;
$$;
REVOKE ALL ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA formos TO intake_caller;
GRANT EXECUTE ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) TO intake_caller;

-- ---------------------------------------------------------------- webhook-attempt metering (per attempt, idempotent)
-- Metric rule: delivery attempts (initial + retry = 2 rows). Inserted in the
-- same transaction as the state transition, keyed on delivery:attempt so a
-- retried record call cannot double-count.
CREATE OR REPLACE FUNCTION formos.record_delivery(
  p_delivery_id UUID,
  p_ok BOOLEAN,
  p_permanent BOOLEAN,
  p_status_code INTEGER,
  p_error TEXT,
  p_ms INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_d public.webhook_deliveries%ROWTYPE;
  v_backoff INTEGER[];
  v_delay INTEGER;
  v_disabled BOOLEAN := false;
BEGIN
  SELECT d.* INTO v_d FROM public.webhook_deliveries d WHERE d.id = p_delivery_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'error', 'not found');
  END IF;
  -- Meter this attempt before transitioning state (same transaction).
  INSERT INTO public.usage_events
    (id, workspace_id, metric, quantity, source, source_id, period_start)
  VALUES
    (formos.new_uuid(), v_d.workspace_id, 'webhook_attempt', 1, 'tick',
     v_d.id::text || ':' || (v_d.attempts + 1)::text,
     formos.period_start((SELECT w.billing_period_start FROM public.workspaces w WHERE w.id = v_d.workspace_id), now()))
  ON CONFLICT (workspace_id, metric, source, source_id) DO NOTHING;
  -- Exponential backoff schedule (~24h over 8 attempts): 1m,5m,15m,1h,3h,9h,24h.
  v_backoff := ARRAY[60, 300, 900, 3600, 10800, 32400, 86400];
  IF p_ok THEN
    UPDATE public.webhook_deliveries
    SET status = 'delivered', response_code = p_status_code, response_ms = p_ms,
        last_error = NULL, delivered_at = now(), attempts = attempts + 1
    WHERE id = v_d.id;
    UPDATE public.webhook_endpoints SET consecutive_failures = 0 WHERE id = v_d.endpoint_id;
    RETURN jsonb_build_object('recorded', true, 'status', 'delivered', 'disabled', false);
  END IF;
  IF p_permanent THEN
    UPDATE public.webhook_deliveries
    SET status = 'failed', response_code = p_status_code, response_ms = p_ms,
        last_error = left(coalesce(p_error, 'permanent failure'), 500), attempts = attempts + 1,
        next_attempt_at = NULL
    WHERE id = v_d.id;
    UPDATE public.webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = v_d.endpoint_id;
  ELSIF v_d.attempts + 1 >= 8 THEN
    UPDATE public.webhook_deliveries
    SET status = 'dead', response_code = p_status_code, response_ms = p_ms,
        last_error = left(coalesce(p_error, 'retries exhausted'), 500), attempts = attempts + 1,
        next_attempt_at = NULL
    WHERE id = v_d.id;
    UPDATE public.webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = v_d.endpoint_id;
  ELSE
    v_delay := v_backoff[least(v_d.attempts + 1, 7)];
    UPDATE public.webhook_deliveries
    SET status = 'pending', response_code = p_status_code, response_ms = p_ms,
        last_error = left(coalesce(p_error, 'retryable failure'), 500), attempts = attempts + 1,
        next_attempt_at = now() + make_interval(secs => v_delay)
    WHERE id = v_d.id;
    UPDATE public.webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = v_d.endpoint_id;
  END IF;
  -- Auto-disable at 50 consecutive failures + audit (actor: system).
  UPDATE public.webhook_endpoints SET is_active = false WHERE id = v_d.endpoint_id AND consecutive_failures >= 50 AND is_active;
  IF FOUND THEN
    v_disabled := true;
    INSERT INTO public.audit_log (id, workspace_id, actor_id, actor_type, action, resource_type, resource_id, diff)
    VALUES (formos.new_uuid(), v_d.workspace_id, NULL, 'system', 'webhook.disabled',
            'webhook_endpoint', v_d.endpoint_id,
            jsonb_build_object('reason', 'consecutive_failures', 'endpoint_id', v_d.endpoint_id));
  END IF;
  RETURN jsonb_build_object('recorded', true, 'status',
    (SELECT status FROM public.webhook_deliveries WHERE id = v_d.id), 'disabled', v_disabled);
END;
$$;
REVOKE ALL ON FUNCTION formos.record_delivery(UUID, BOOLEAN, BOOLEAN, INTEGER, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.record_delivery(UUID, BOOLEAN, BOOLEAN, INTEGER, TEXT, INTEGER) TO service_role;

-- ---------------------------------------------------------------- api_keys: read-only billing scope
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_check;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_scopes_check
  CHECK (scopes <@ ARRAY['forms:read', 'submissions:read', 'webhooks:read', 'billing:read'] AND cardinality(scopes) > 0);

CREATE OR REPLACE FUNCTION formos.create_api_key(
  p_id UUID,
  p_workspace_id UUID,
  p_prefix TEXT,
  p_secret_hash TEXT,
  p_name TEXT,
  p_scopes TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_allowed TEXT[] := ARRAY['forms:read', 'submissions:read', 'webhooks:read', 'billing:read'];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_prefix IS NULL OR p_prefix !~ '^[A-Za-z0-9]{12}$' THEN
    RAISE EXCEPTION 'invalid prefix';
  END IF;
  IF p_secret_hash IS NULL OR p_secret_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid secret hash';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 OR NOT (p_scopes <@ v_allowed) THEN
    RAISE EXCEPTION 'invalid scopes';
  END IF;
  INSERT INTO public.api_keys (id, workspace_id, key_prefix, secret_hash, name, scopes, created_by)
  VALUES (p_id, p_workspace_id, p_prefix, p_secret_hash, left(coalesce(p_name, ''), 80), p_scopes, auth.uid());
  RETURN jsonb_build_object(
    'id', p_id, 'workspace_id', p_workspace_id, 'prefix', p_prefix,
    'name', left(coalesce(p_name, ''), 80), 'scopes', to_jsonb(p_scopes),
    'created_at', now(), 'revoked_at', NULL, 'last_used_at', NULL
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'prefix in use';
END;
$$;
REVOKE ALL ON FUNCTION formos.create_api_key(UUID, UUID, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.create_api_key(UUID, UUID, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;

-- ---------------------------------------------------------------- public wrappers (PostgREST surface)
-- check_quota/record_usage: service_role-only (trusted BFF paths after key
-- auth). Member paths use check_quota_member/get_usage_summary below.
CREATE OR REPLACE FUNCTION public.check_quota(
  p_workspace_id UUID, p_metric TEXT, p_quantity INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.check_quota(p_workspace_id, p_metric, p_quantity);
$$;
REVOKE ALL ON FUNCTION public.check_quota(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_quota(UUID, TEXT, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.record_usage(
  p_workspace_id UUID, p_metric TEXT, p_source TEXT, p_source_id TEXT,
  p_quantity INTEGER DEFAULT 1, p_occurred_at TIMESTAMPTZ DEFAULT now()
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.record_usage(p_workspace_id, p_metric, p_source, p_source_id, p_quantity, p_occurred_at);
$$;
REVOKE ALL ON FUNCTION public.record_usage(UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_usage(UUID, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION public.check_quota_member(
  p_workspace_id UUID, p_metric TEXT, p_quantity INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.check_quota_member(p_workspace_id, p_metric, p_quantity);
$$;
REVOKE ALL ON FUNCTION public.check_quota_member(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_quota_member(UUID, TEXT, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_usage_summary(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.get_usage_summary(p_workspace_id);
$$;
REVOKE ALL ON FUNCTION public.get_usage_summary(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_usage_summary(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_usage_summary(UUID) TO service_role;
