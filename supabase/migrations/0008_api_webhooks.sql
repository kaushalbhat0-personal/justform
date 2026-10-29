-- FORMOS migration 0008 — API key + webhook foundation (Phase 9).
--
-- Adds the minimum secure surface for programmatic access and outbound events.
-- No changes to intake, submissions core, RLS on existing tables, or the
-- frozen execution boundaries. Follows 0001 conventions: portable SQL, zero
-- extensions, pinned-search_path DEFINER, RLS deny-by-default + FORCE,
-- app-generated UUIDs, RPC-only writes (no DML grants, ever).
--
-- Tables (all RPC-managed; REVOKE ALL, no policies, no direct grants):
--   api_keys            — workspace-scoped credentials (prefix + SHA-256 hash
--                         only; plaintext shown once at creation, never stored)
--   webhook_endpoints   — workspace/form-scoped subscriptions (secret stored
--                         AES-256-GCM encrypted; decrypted only in the worker)
--   webhook_deliveries  — per-endpoint delivery ledger (idempotent on
--                         (endpoint_id, outbox_event_id); retry state + DLQ)
-- Extends formos.set_submission_status with an outbox event (atomic with the
-- status change; receipt shape unchanged).

-- ---------------------------------------------------------------- API keys
CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  -- Non-secret public identifier (shown in UI/headers; used for lookup).
  key_prefix TEXT NOT NULL UNIQUE CHECK (key_prefix ~ '^[A-Za-z0-9]{12}$'),
  -- SHA-256 hex of the full presented key. The raw secret NEVER persists.
  secret_hash TEXT NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  name TEXT NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
  scopes TEXT[] NOT NULL DEFAULT '{}'
    CHECK (scopes <@ ARRAY['forms:read', 'submissions:read', 'webhooks:read'] AND cardinality(scopes) > 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX api_keys_workspace_idx ON public.api_keys (workspace_id);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_keys FROM anon, authenticated;
-- No policies, no DML grants: management flows exclusively through the
-- SECURITY DEFINER RPCs below (owner/admin floor).

-- ---------------------------------------------------------------- webhooks
CREATE TABLE public.webhook_endpoints (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  -- NULL = all workspace forms; otherwise pinned to one form (must belong
  -- to the same workspace — enforced in the create RPC).
  form_id UUID REFERENCES public.forms (id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  -- AES-256-GCM ciphertext (base64 iv|cipher|tag); decrypted only in-worker.
  secret_enc TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}'
    CHECK (events <@ ARRAY['submission.created', 'submission.status_changed'] AND cardinality(events) > 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_workspace_idx ON public.webhook_endpoints (workspace_id);
CREATE INDEX webhook_endpoints_active_idx ON public.webhook_endpoints (workspace_id, is_active)
  WHERE is_active;
CREATE TRIGGER webhook_endpoints_updated_at
  BEFORE UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER webhook_endpoints_workspace_immutable
  BEFORE UPDATE ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_endpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_endpoints FROM anon, authenticated;
-- No policies, no DML grants: management flows exclusively through the
-- SECURITY DEFINER RPCs below (owner/admin floor via the integration grant).

CREATE TABLE public.webhook_deliveries (
  id UUID PRIMARY KEY,
  endpoint_id UUID NOT NULL REFERENCES public.webhook_endpoints (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  -- Idempotency key: one logical delivery per (endpoint, outbox event).
  outbox_event_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'delivered', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  response_code INTEGER,
  response_ms INTEGER,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, outbox_event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON public.webhook_deliveries (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_endpoint_idx ON public.webhook_deliveries (endpoint_id, created_at DESC);
CREATE TRIGGER webhook_deliveries_updated_at
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER webhook_deliveries_workspace_immutable
  BEFORE UPDATE ON public.webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_deliveries FROM anon, authenticated;
-- No policies, no DML grants: the tick pump (DEFINER RPCs below) is the only
-- writer; reads go through the RPC or the privileged worker path.

-- ---------------------------------------------------------------- API key RPCs
-- Owner/admin floor (mirrors the domain matrix: api_key.* = admin).
-- Secrets never round-trip: create returns metadata only (the BFF shows the
-- one-time plaintext from memory); hashes are never selected back.

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
  v_allowed TEXT[] := ARRAY['forms:read', 'submissions:read', 'webhooks:read'];
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

CREATE OR REPLACE FUNCTION formos.list_api_keys(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', k.id, 'prefix', k.key_prefix, 'name', k.name, 'scopes', to_jsonb(k.scopes),
      'created_at', k.created_at, 'revoked_at', k.revoked_at, 'last_used_at', k.last_used_at
    ) ORDER BY k.created_at DESC)
    FROM public.api_keys k WHERE k.workspace_id = p_workspace_id
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION formos.list_api_keys(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.list_api_keys(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION formos.revoke_api_key(p_key_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key public.api_keys%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT k.* INTO v_key FROM public.api_keys k WHERE k.id = p_key_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_key.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = v_key.id;
  RETURN jsonb_build_object(
    'id', v_key.id, 'workspace_id', v_key.workspace_id, 'prefix', v_key.key_prefix,
    'name', v_key.name, 'scopes', to_jsonb(v_key.scopes),
    'created_at', v_key.created_at, 'revoked_at', coalesce(v_key.revoked_at, now()), 'last_used_at', v_key.last_used_at
  );
END;
$$;
REVOKE ALL ON FUNCTION formos.revoke_api_key(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.revoke_api_key(UUID) TO authenticated;

-- ---------------------------------------------------------------- webhook RPCs
-- Owner/admin floor (webhooks are integrations: integration.* = admin floor).
-- Secrets are accepted pre-encrypted and never returned; list payloads carry
-- metadata plus the latest delivery outcome only.

CREATE OR REPLACE FUNCTION formos.create_webhook(
  p_id UUID,
  p_workspace_id UUID,
  p_form_id UUID,
  p_url TEXT,
  p_secret_enc TEXT,
  p_events TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_allowed TEXT[] := ARRAY['submission.created', 'submission.status_changed'];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_form_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.forms f WHERE f.id = p_form_id AND f.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'form not in workspace';
  END IF;
  IF p_url IS NULL OR char_length(p_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'invalid url';
  END IF;
  IF p_secret_enc IS NULL OR char_length(p_secret_enc) NOT BETWEEN 16 AND 4096 THEN
    RAISE EXCEPTION 'invalid secret';
  END IF;
  IF p_events IS NULL OR cardinality(p_events) = 0 OR NOT (p_events <@ v_allowed) THEN
    RAISE EXCEPTION 'invalid events';
  END IF;
  INSERT INTO public.webhook_endpoints (id, workspace_id, form_id, url, secret_enc, events, created_by)
  VALUES (p_id, p_workspace_id, p_form_id, p_url, p_secret_enc, p_events, auth.uid());
  RETURN jsonb_build_object(
    'id', p_id, 'workspace_id', p_workspace_id, 'form_id', p_form_id,
    'url', p_url, 'events', to_jsonb(p_events), 'is_active', true,
    'consecutive_failures', 0, 'created_at', now()
  );
END;
$$;
REVOKE ALL ON FUNCTION formos.create_webhook(UUID, UUID, UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.create_webhook(UUID, UUID, UUID, TEXT, TEXT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION formos.list_webhooks(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF formos.role_rank(formos.my_role(p_workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id, 'form_id', e.form_id, 'url', e.url, 'events', to_jsonb(e.events),
      'is_active', e.is_active, 'consecutive_failures', e.consecutive_failures,
      'created_at', e.created_at, 'updated_at', e.updated_at,
      'last_delivery', (
        SELECT jsonb_build_object(
          'status', d.status, 'response_code', d.response_code,
          'attempts', d.attempts, 'delivered_at', d.delivered_at, 'created_at', d.created_at
        )
        FROM public.webhook_deliveries d
        WHERE d.endpoint_id = e.id
        ORDER BY d.created_at DESC LIMIT 1
      )
    ) ORDER BY e.created_at DESC)
    FROM public.webhook_endpoints e WHERE e.workspace_id = p_workspace_id
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION formos.list_webhooks(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.list_webhooks(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION formos.update_webhook(
  p_id UUID,
  p_url TEXT,
  p_events TEXT[],
  p_is_active BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ep public.webhook_endpoints%ROWTYPE;
  v_allowed TEXT[] := ARRAY['submission.created', 'submission.status_changed'];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT e.* INTO v_ep FROM public.webhook_endpoints e WHERE e.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_ep.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_url IS NULL OR char_length(p_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'invalid url';
  END IF;
  IF p_events IS NULL OR cardinality(p_events) = 0 OR NOT (p_events <@ v_allowed) THEN
    RAISE EXCEPTION 'invalid events';
  END IF;
  IF p_is_active IS NULL THEN
    RAISE EXCEPTION 'invalid active flag';
  END IF;
  UPDATE public.webhook_endpoints
  SET url = p_url,
      events = p_events,
      is_active = p_is_active,
      consecutive_failures = CASE WHEN p_is_active THEN 0 ELSE consecutive_failures END
  WHERE id = v_ep.id;
  RETURN jsonb_build_object('id', v_ep.id, 'updated', true, 'is_active', p_is_active);
END;
$$;
REVOKE ALL ON FUNCTION formos.update_webhook(UUID, TEXT, TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.update_webhook(UUID, TEXT, TEXT[], BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION formos.rotate_webhook_secret(p_id UUID, p_secret_enc TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ep public.webhook_endpoints%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT e.* INTO v_ep FROM public.webhook_endpoints e WHERE e.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_ep.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_secret_enc IS NULL OR char_length(p_secret_enc) NOT BETWEEN 16 AND 4096 THEN
    RAISE EXCEPTION 'invalid secret';
  END IF;
  UPDATE public.webhook_endpoints SET secret_enc = p_secret_enc WHERE id = v_ep.id;
  RETURN jsonb_build_object('id', v_ep.id, 'rotated', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.rotate_webhook_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.rotate_webhook_secret(UUID, TEXT) TO authenticated;

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
  -- Keyset pagination on (created_at DESC, id DESC); p_cursor is base64url JSON {t, id}.
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'event_type', d.event_type, 'status', d.status,
      'attempts', d.attempts, 'response_code', d.response_code,
      'response_ms', d.response_ms, 'last_error', d.last_error,
      'delivered_at', d.delivered_at, 'created_at', d.created_at
    ) ORDER BY d.created_at DESC, d.id DESC)
    FROM (
      SELECT d.* FROM public.webhook_deliveries d
      WHERE d.endpoint_id = p_endpoint_id
        AND (
          p_cursor IS NULL OR p_cursor = '' OR
          (d.created_at, d.id) < (
            SELECT (to_timestamp((convert_from(decode(split_part(p_cursor, '.', 1), 'base64'), 'utf8')::jsonb ->> 't')::double precision),
                    ((convert_from(decode(split_part(p_cursor, '.', 1), 'base64'), 'utf8')::jsonb ->> 'id'))::uuid)
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

-- ---------------------------------------------------------------- tick pump RPCs
-- Service-role-only surface (no EXECUTE grants to anon/authenticated; the
-- worker uses the service key). The BFF tick route authenticates the CRON
-- bearer first; these functions additionally take no caller trust.
-- NOTE: `service_role` exists in Supabase but not in PGlite — create it
-- idempotently so portable tests apply this migration unchanged.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role WITH NOLOGIN;
  END IF;
END $$;

-- Portable UUID generation (md5-based; avoids extensions per the G5 rule).
-- Used only for worker-side rows (deliveries, audit); all product identity
-- remains app-generated UUIDv7 per convention.
CREATE OR REPLACE FUNCTION formos.new_uuid()
RETURNS UUID
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (
    substring(h FROM 1 FOR 8) || '-' || substring(h FROM 9 FOR 4) || '-' ||
    substring(h FROM 13 FOR 4) || '-' || substring(h FROM 17 FOR 4) || '-' ||
    substring(h FROM 21 FOR 12)
  )::uuid
  FROM md5(random()::text || clock_timestamp()::text) AS h
$$;
REVOKE ALL ON FUNCTION formos.new_uuid() FROM PUBLIC, anon, authenticated;

-- Single-flight fan-out pump. One call claims a bounded outbox batch,
-- expands each event into deliveries, and marks events done — all in ONE
-- transaction guarded by a transaction-scoped advisory lock (auto-released;
-- safe under pooled connections, no unlock needed, no leak possible).
-- Concurrent callers serialize here; per-row SKIP LOCKED + the idempotency
-- UNIQUE(endpoint_id, outbox_event_id) make overlap safe regardless.
CREATE OR REPLACE FUNCTION formos.tick_fanout(p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit INTEGER := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_claimed INTEGER := 0;
  v_expanded INTEGER := 0;
  v_skipped INTEGER := 0;
  v_failed INTEGER := 0;
  r RECORD;
  v_mapped TEXT;
  v_n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('formos.outbox.fanout')::bigint);
  FOR r IN
    SELECT o.id, o.workspace_id, o.event_type, o.aggregate_id, o.payload, o.attempts
    FROM public.outbox o
    WHERE (o.status = 'pending')
       OR (o.status = 'failed' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at <= now())
       OR (o.status = 'claimed' AND o.claimed_at < now() - interval '5 minutes')
    ORDER BY o.next_attempt_at, o.created_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_claimed := v_claimed + 1;
    BEGIN
      v_mapped := CASE r.event_type
        WHEN 'submission.completed' THEN 'submission.created'
        WHEN 'submission.status_changed' THEN 'submission.status_changed'
        ELSE NULL
      END;
      IF v_mapped IS NULL THEN
        UPDATE public.outbox SET status = 'done', claimed_at = NULL WHERE id = r.id;
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      INSERT INTO public.webhook_deliveries
        (id, endpoint_id, workspace_id, outbox_event_id, event_type, status, next_attempt_at)
      SELECT formos.new_uuid(), e.id, r.workspace_id, r.id, v_mapped, 'pending', now()
      FROM public.webhook_endpoints e
      WHERE e.workspace_id = r.workspace_id
        AND e.is_active
        AND v_mapped = ANY (e.events)
        AND (
          e.form_id IS NULL
          OR e.form_id::text = coalesce(r.payload ->> 'form_id', '')
        )
      ON CONFLICT (endpoint_id, outbox_event_id) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_expanded := v_expanded + v_n;
      UPDATE public.outbox SET status = 'done', claimed_at = NULL WHERE id = r.id;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.outbox
      SET status = 'failed',
          attempts = attempts + 1,
          last_error = left(SQLERRM, 500),
          claimed_at = NULL,
          next_attempt_at = CASE
            WHEN attempts + 1 >= 25 THEN NULL
            ELSE now() + make_interval(secs => (power(2, least(attempts + 1, 10)) * 5)::double precision)
          END
      WHERE id = r.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('claimed', v_claimed, 'expanded', v_expanded, 'skipped', v_skipped, 'failed', v_failed);
END;
$$;
REVOKE ALL ON FUNCTION formos.tick_fanout(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.tick_fanout(INTEGER) TO service_role;

-- Claim due webhook deliveries for HTTP dispatch (bounded; lease-guarded).
CREATE OR REPLACE FUNCTION formos.claim_deliveries(p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit INTEGER := least(greatest(coalesce(p_limit, 25), 1), 100);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('formos.webhooks.claim')::bigint);
  RETURN coalesce((
    WITH claimed AS (
      SELECT d.id FROM public.webhook_deliveries d
      WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
         OR (d.status = 'failed' AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= now())
         OR (d.status = 'claimed' AND d.claimed_at < now() - interval '5 minutes')
      ORDER BY d.next_attempt_at
      LIMIT v_limit
      FOR UPDATE SKIP LOCKED
    ),
    updated AS (
      UPDATE public.webhook_deliveries d
      SET status = 'claimed', claimed_at = now()
      FROM claimed c, public.webhook_endpoints e
      WHERE d.id = c.id AND e.id = d.endpoint_id
      RETURNING d.id, d.endpoint_id, d.workspace_id, d.outbox_event_id,
                d.event_type, d.attempts, e.url, e.secret_enc, e.form_id
    )
    SELECT jsonb_agg(jsonb_build_object(
      'id', u.id, 'endpoint_id', u.endpoint_id, 'workspace_id', u.workspace_id,
      'outbox_event_id', u.outbox_event_id, 'event_type', u.event_type,
      'attempts', u.attempts, 'url', u.url, 'secret_enc', u.secret_enc, 'form_id', u.form_id,
      'payload', (SELECT o.payload FROM public.outbox o WHERE o.id = u.outbox_event_id),
      'occurred_at', (SELECT o.created_at FROM public.outbox o WHERE o.id = u.outbox_event_id)
    ) ORDER BY u.id) FROM updated u
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION formos.claim_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.claim_deliveries(INTEGER) TO service_role;

-- Record an HTTP dispatch outcome. Applies retry/DLQ/auto-disable, returns the
-- verdict (the BFF performs HTTP + crypto; the DB owns state transitions).
-- p_ok: transport succeeded AND response was retryable-or-final per caller.
-- p_permanent: true when the response must never be retried (4xx-class).
-- p_disabled_by_caller is unused; auto-disable is computed here.
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

-- ---------------------------------------------------------------- status-change events
-- Extend the phase-7 status RPC with an atomic outbox event (opt-in per call
-- via p_event_id; NULL emits nothing). Receipt shape is UNCHANGED.
-- v1 outbox payload carries receipt metadata + from/to only — never payloads.
CREATE OR REPLACE FUNCTION formos.set_submission_status(
  p_submission_id UUID,
  p_status TEXT,
  p_event_id UUID
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

-- Retire the 2-arg variant so every status change flows through the
-- event-emitting path (callers pass an app-generated event id, or NULL).
DROP FUNCTION IF EXISTS formos.set_submission_status(UUID, TEXT);

-- ---------------------------------------------------------------- public wrappers
-- PostgREST surface for member control-plane RPCs (thin delegation only,
-- following the 0004/0005 pattern). EXECUTE to authenticated; anon excluded.
-- Tick internals (claim/fanout/record/lock/new_uuid) deliberately have NO
-- public wrapper and NO grants: the worker uses the service key.
CREATE OR REPLACE FUNCTION public.create_api_key(
  p_id UUID, p_workspace_id UUID, p_prefix TEXT, p_secret_hash TEXT, p_name TEXT, p_scopes TEXT[]
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.create_api_key(p_id, p_workspace_id, p_prefix, p_secret_hash, p_name, p_scopes);
$$;
REVOKE ALL ON FUNCTION public.create_api_key(UUID, UUID, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_key(UUID, UUID, TEXT, TEXT, TEXT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_api_keys(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.list_api_keys(p_workspace_id);
$$;
REVOKE ALL ON FUNCTION public.list_api_keys(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_api_keys(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_api_key(p_key_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.revoke_api_key(p_key_id);
$$;
REVOKE ALL ON FUNCTION public.revoke_api_key(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_webhook(
  p_id UUID, p_workspace_id UUID, p_form_id UUID, p_url TEXT, p_secret_enc TEXT, p_events TEXT[]
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.create_webhook(p_id, p_workspace_id, p_form_id, p_url, p_secret_enc, p_events);
$$;
REVOKE ALL ON FUNCTION public.create_webhook(UUID, UUID, UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_webhook(UUID, UUID, UUID, TEXT, TEXT, TEXT[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_webhooks(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.list_webhooks(p_workspace_id);
$$;
REVOKE ALL ON FUNCTION public.list_webhooks(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_webhooks(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_webhook(
  p_id UUID, p_url TEXT, p_events TEXT[], p_is_active BOOLEAN
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.update_webhook(p_id, p_url, p_events, p_is_active);
$$;
REVOKE ALL ON FUNCTION public.update_webhook(UUID, TEXT, TEXT[], BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_webhook(UUID, TEXT, TEXT[], BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.rotate_webhook_secret(p_id UUID, p_secret_enc TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.rotate_webhook_secret(p_id, p_secret_enc);
$$;
REVOKE ALL ON FUNCTION public.rotate_webhook_secret(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_webhook_secret(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_deliveries(p_endpoint_id UUID, p_limit INTEGER, p_cursor TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.list_deliveries(p_endpoint_id, p_limit, p_cursor);
$$;
REVOKE ALL ON FUNCTION public.list_deliveries(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_deliveries(UUID, INTEGER, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_submission_status(
  p_submission_id UUID,
  p_status TEXT,
  p_event_id UUID
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
DROP FUNCTION IF EXISTS public.set_submission_status(UUID, TEXT);
