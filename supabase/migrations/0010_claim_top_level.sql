-- FORMOS migration 0010 — claim_deliveries top-level rewrite (Phase 9 follow-up).
--
-- Real Postgres forbids data-modifying CTEs anywhere but the top level of a
-- statement; 0008 nested the claim UPDATE inside RETURN (...), which fails
-- on Postgres with "WITH clause containing a data-modifying statement must
-- be at the top level". This replaces the function with an equivalent
-- top-level form: lock due ids → UPDATE exactly those rows → SELECT the
-- batch back with endpoint material. Single-flight still holds via the
-- transaction-scoped advisory lock; the SELECT-back is scoped to the locked
-- ids, so concurrent ticks stay safe. No table, grant, or policy changes.

CREATE OR REPLACE FUNCTION formos.claim_deliveries(p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit INTEGER := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_claimed UUID[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('formos.webhooks.claim')::bigint);
  -- Due deliveries: bounded batch, lease-guarded, locks held to xact end.
  SELECT coalesce(array_agg(t.id), '{}') INTO v_claimed
  FROM (
    SELECT d.id FROM public.webhook_deliveries d
    WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
       OR (d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now())
       OR (d.status = 'claimed' AND d.claimed_at < now() - interval '5 minutes')
    ORDER BY d.next_attempt_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ) t;
  IF coalesce(array_length(v_claimed, 1), 0) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  -- Claim exactly the locked rows (top-level UPDATE by id set).
  UPDATE public.webhook_deliveries d
  SET status = 'claimed', claimed_at = now()
  WHERE d.id = ANY (v_claimed);
  -- Read the claimed batch back with endpoint material for the HTTP worker.
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', u.id, 'endpoint_id', u.endpoint_id, 'workspace_id', u.workspace_id,
      'outbox_event_id', u.outbox_event_id, 'event_type', u.event_type,
      'attempts', u.attempts, 'url', e.url, 'secret_enc', e.secret_enc, 'form_id', e.form_id,
      'payload', (SELECT o.payload FROM public.outbox o WHERE o.id = u.outbox_event_id),
      'occurred_at', (SELECT o.created_at FROM public.outbox o WHERE o.id = u.outbox_event_id)
    ) ORDER BY u.id)
    FROM public.webhook_deliveries u
    JOIN public.webhook_endpoints e ON e.id = u.endpoint_id
    WHERE u.id = ANY (v_claimed)
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION formos.claim_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.claim_deliveries(INTEGER) TO service_role;
