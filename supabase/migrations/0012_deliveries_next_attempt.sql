-- FORMOS migration 0012 — expose next_attempt_at in list_deliveries (Phase 9 follow-up).
--
-- Operators (and the live verification suite) need to distinguish "pending
-- with a scheduled retry" from stuck rows. The reader RPC omitted
-- next_attempt_at; add it to the payload. Read-only shape change, no
-- grants/policies/RLS changes.

CREATE OR REPLACE FUNCTION formos.list_deliveries(p_endpoint_id UUID, p_limit INTEGER, p_cursor TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ep public.webhook_endpoints%ROWTYPE;
  v_limit INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT e.* INTO v_ep FROM public.webhook_endpoints e WHERE e.id = p_endpoint_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_ep.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);
  -- Fail closed on malformed cursors (uniform error, no SQL detail).
  IF p_cursor IS NOT NULL AND p_cursor <> '' THEN
    BEGIN
      PERFORM to_timestamp(((convert_from(decode(translate(split_part(p_cursor, '.', 1), '-_', '+/'), 'base64'), 'utf8'))::jsonb ->> 't')::double precision),
              ((convert_from(decode(translate(split_part(p_cursor, '.', 1), '-_', '+/'), 'base64'), 'utf8'))::jsonb ->> 'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid cursor';
    END;
  END IF;
  -- Keyset pagination on (created_at DESC, id DESC); p_cursor is base64url JSON {t, id}.
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'event_type', d.event_type, 'status', d.status,
      'attempts', d.attempts, 'response_code', d.response_code,
      'response_ms', d.response_ms, 'last_error', d.last_error,
      'next_attempt_at', d.next_attempt_at,
      'delivered_at', d.delivered_at, 'created_at', d.created_at
    ) ORDER BY d.created_at DESC, d.id DESC)
    FROM (
      SELECT d.* FROM public.webhook_deliveries d
      WHERE d.endpoint_id = p_endpoint_id
        AND (
          p_cursor IS NULL OR p_cursor = '' OR
          (d.created_at, d.id) < (
            SELECT to_timestamp(((convert_from(decode(translate(split_part(p_cursor, '.', 1), '-_', '+/'), 'base64'), 'utf8'))::jsonb ->> 't')::double precision),
                   ((convert_from(decode(translate(split_part(p_cursor, '.', 1), '-_', '+/'), 'base64'), 'utf8'))::jsonb ->> 'id')::uuid
          )
        )
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT v_limit + 1
    ) d
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION formos.list_deliveries(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.list_deliveries(UUID, INTEGER, TEXT) TO authenticated;
