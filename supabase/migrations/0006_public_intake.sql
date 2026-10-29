-- FORMOS migration 0006 — public publication identity + secure submission intake.
--
-- Model (minimal, three tables + two RPCs):
--   form_publications — one stable unguessable public identity per form, pinning
--     the immutable published version being served (+ active flag, schedule,
--     submission cap, optional unique-field constraint). Member-managed.
--   submissions       — immutable respondent receipts. RPC-only writes, zero
--     table grants, zero policies (deny by default + FORCE RLS).
--   outbox            — transactional events for the Stage 0 pump (scheduled tick
--     route; no worker in this phase). RPC-only, same lockdown as submissions.
--
-- Request path (frozen ARCH-FIX-002): Browser → Public API/BFF (Zod) →
-- least-privilege `intake_caller` (EXECUTE-only) → SECURITY DEFINER
-- formos.submit_submission → single Postgres transaction
-- (submission + outbox). The browser NEVER invokes the intake RPC: it has no
-- public-schema wrapper and no EXECUTE grant to anon/authenticated.
-- Follows 0001 conventions: portable SQL, zero extensions, pinned-search_path
-- DEFINER, RLS deny-by-default + FORCE, app-generated UUIDs.

-- ---------------------------------------------------------------- intake role
-- Least-privilege caller for the public intake path: EXECUTE on the intake
-- function only, zero table grants. LOGIN without a password here — the
-- password is provisioned out-of-band (never committed):
--   ALTER ROLE intake_caller WITH LOGIN PASSWORD '<from vault>';
-- (scripts/verify/public-intake-live.mjs performs this against live projects;
-- local/staging operators run the same statement from a superuser session.)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'intake_caller') THEN
    CREATE ROLE intake_caller WITH NOLOGIN;
  END IF;
END $$;

-- ---------------------------------------------------------------- publications
CREATE TABLE public.form_publications (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  form_version_id UUID NOT NULL REFERENCES public.form_versions (id) ON DELETE CASCADE,
  -- Unguessable public identifier (app-generated 128-bit base64url, 22 chars).
  -- Never the internal form UUID, never sequential.
  public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  is_active BOOLEAN NOT NULL DEFAULT true,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  max_submissions INTEGER CHECK (max_submissions IS NULL OR max_submissions > 0),
  -- Optional canonical field `key` whose submitted value must be unique per
  -- publication (e.g. a coupon code). NULL = no uniqueness constraint.
  unique_field_key TEXT CHECK (unique_field_key IS NULL OR unique_field_key ~ '^[a-z0-9_]{1,64}$'),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One publication identity per form: publish repoints it, never duplicates it.
  UNIQUE (form_id),
  CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)
);
CREATE INDEX form_publications_workspace_idx ON public.form_publications (workspace_id);
CREATE INDEX form_publications_version_idx ON public.form_publications (form_version_id);
CREATE TRIGGER form_publications_updated_at
  BEFORE UPDATE ON public.form_publications
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER form_publications_workspace_immutable
  BEFORE UPDATE ON public.form_publications
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.form_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_publications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_publications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.form_publications TO authenticated;

-- Members read the publication of their own workspace (needed to display the
-- public URL in the builder). No anon grant: public resolution goes through
-- the redacted DEFINER resolver only.
CREATE POLICY form_publications_member_read ON public.form_publications
  FOR SELECT TO PUBLIC USING (formos.is_member(workspace_id));
-- Builder+ manage the publication lifecycle (create/repoint/archive).
CREATE POLICY form_publications_builder_insert ON public.form_publications
  FOR INSERT TO PUBLIC WITH CHECK (formos.is_builder_or_above(workspace_id));
CREATE POLICY form_publications_builder_update ON public.form_publications
  FOR UPDATE TO PUBLIC
  USING (formos.is_builder_or_above(workspace_id))
  WITH CHECK (formos.is_builder_or_above(workspace_id));
CREATE POLICY form_publications_builder_delete ON public.form_publications
  FOR DELETE TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- submissions
-- Immutable respondent receipts. Workspace/form/version are resolved from the
-- publication row inside the intake RPC — never trusted from the caller.
CREATE TABLE public.submissions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  publication_id UUID NOT NULL REFERENCES public.form_publications (id) ON DELETE CASCADE,
  form_version_id UUID NOT NULL REFERENCES public.form_versions (id) ON DELETE CASCADE,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (publication_id, idempotency_key),
  -- Database-level request-size floor (BFF enforces the same limit first).
  CHECK (octet_length(payload::text) <= 262144)
);
CREATE INDEX submissions_publication_time_idx ON public.submissions (publication_id, submitted_at);
CREATE INDEX submissions_workspace_idx ON public.submissions (workspace_id);

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.submissions FROM anon, authenticated;
-- No grants, no policies: writes flow exclusively through
-- formos.submit_submission (SECURITY DEFINER, intake_caller EXECUTE-only).

-- ---------------------------------------------------------------- outbox
-- Transactional events for the frozen Stage 0 pump (scheduled tick route
-- claims rows; no worker ships in this phase). Payloads carry receipt
-- metadata only — never respondent payloads, never secrets.
CREATE TABLE public.outbox (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_claim_idx ON public.outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX outbox_aggregate_idx ON public.outbox (aggregate_type, aggregate_id);
CREATE TRIGGER outbox_updated_at
  BEFORE UPDATE ON public.outbox
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER outbox_workspace_immutable
  BEFORE UPDATE ON public.outbox
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbox FROM anon, authenticated;
-- No grants, no policies: the intake transaction writes rows; the Stage 0
-- pump reads them with a privileged worker role in a later phase.

-- ---------------------------------------------------------------- public resolver
-- Redacted publication lookup for anonymous respondents. Returns the immutable
-- published snapshot plus availability state — never workspace ids, never the
-- draft, never private metadata. Missing identifiers raise a uniform
-- 'not available' (no enumeration oracle); schedule/cap states are returned
-- as data so the UI can render distinct closed states.
CREATE OR REPLACE FUNCTION formos.resolve_public_form(p_public_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_pub public.form_publications%ROWTYPE;
  v_form public.forms%ROWTYPE;
  v_ver public.form_versions%ROWTYPE;
  v_count BIGINT;
BEGIN
  IF p_public_id IS NULL OR p_public_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'not available';
  END IF;
  SELECT p.* INTO v_pub FROM public.form_publications p WHERE p.public_id = p_public_id;
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
    RETURN jsonb_build_object('available', false, 'reason', 'not_open', 'public_id', p_public_id);
  END IF;
  IF v_pub.closes_at IS NOT NULL AND now() >= v_pub.closes_at THEN
    RETURN jsonb_build_object('available', false, 'reason', 'closed', 'public_id', p_public_id);
  END IF;
  IF v_pub.max_submissions IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.submissions s WHERE s.publication_id = v_pub.id;
    IF v_count >= v_pub.max_submissions THEN
      RETURN jsonb_build_object('available', false, 'reason', 'capped', 'public_id', p_public_id);
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'available', true,
    'public_id', v_pub.public_id,
    'title', v_form.title,
    'description', v_form.description,
    'published_version_no', v_ver.published_version_no,
    'schema_snapshot', v_ver.schema_snapshot,
    'schema_version', v_ver.schema_version,
    'schema_hash', v_ver.schema_hash,
    'renderer_version', v_ver.renderer_version
  );
END;
$$;
REVOKE ALL ON FUNCTION formos.resolve_public_form(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.resolve_public_form(TEXT) TO anon, authenticated;

-- ---------------------------------------------------------------- intake RPC
-- The ONLY submission writer. Called exclusively by the BFF through the
-- least-privilege `intake_caller` role. Re-verifies every trust-relevant
-- invariant inside the transaction (publication, schedule, caps, uniqueness,
-- idempotency, attachment gating) and commits submission + outbox atomically.
-- Returns a receipt only — no SELECT-back of stored rows.
-- Error vocabulary (BFF maps these to public codes, never forwarded raw):
--   not available | not open | closed | limit reached | duplicate |
--   invalid payload | payload too large | attachments not available
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
BEGIN
  -- Defensive shape floor (Zod already ran in the BFF; a violation here means
  -- Layer 1 was bypassed and is a 500-class integrity signal, never trusted).
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

  -- Authority chain: the public identifier resolves everything. Row lock
  -- serializes cap/idempotency checks per publication (correctness first;
  -- throughput tuning is a later-phase concern with measurements).
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

  -- Idempotency: a repeated key returns the original receipt, never a dup.
  SELECT s.id INTO v_existing FROM public.submissions s
  WHERE s.publication_id = v_pub.id AND s.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('submission_id', v_existing, 'duplicate', true, 'status', 'received');
  END IF;

  -- Submission cap (enforced in-transaction under the publication lock).
  IF v_pub.max_submissions IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM public.submissions s WHERE s.publication_id = v_pub.id;
    IF v_count >= v_pub.max_submissions THEN
      RAISE EXCEPTION 'limit reached';
    END IF;
  END IF;

  -- Optional unique-field constraint (advisory-locked against races).
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

  -- Attachment gating: the secure file pipeline is deferred, so non-empty
  -- file references are rejected rather than stored (never arbitrary paths).
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

  -- Outbox event commits atomically with the submission: never one without
  -- the other. Receipt metadata only — no respondent payload, no secrets.
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

  RETURN jsonb_build_object('submission_id', p_submission_id, 'duplicate', false, 'status', 'received');
END;
$$;
REVOKE ALL ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA formos TO intake_caller;
GRANT EXECUTE ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) TO intake_caller;

-- ---------------------------------------------------------------- public wrapper (PostgREST surface)
-- The resolver is safe for anonymous callers (redacted output, uniform
-- errors). The intake function DELIBERATELY has no public wrapper: PostgREST
-- serves only the `public` schema, so no browser can invoke it.
CREATE OR REPLACE FUNCTION public.resolve_public_form(p_public_id TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.resolve_public_form(p_public_id);
$$;
REVOKE ALL ON FUNCTION public.resolve_public_form(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_form(TEXT) TO anon, authenticated;
