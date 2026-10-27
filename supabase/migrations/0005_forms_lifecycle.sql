-- FORMOS migration 0005 — form persistence: drafts, revisions, immutable published versions.
--
-- Model (minimal, two tables):
--   forms          — stable identity + mutable draft (payload + draft_revision for OCC).
--   form_versions  — immutable published snapshots (INSERT via RPC only; trigger-blocked
--                    UPDATE/DELETE; no DML policies, ever).
-- No form_drafts table (the draft lives on the form row) and no form_publications
-- table (public URLs are out of scope). Follows 0001 conventions: portable SQL,
-- zero extensions, pinned-`search_path` DEFINER, RLS deny-by-default + FORCE.

-- ---------------------------------------------------------------- role helper
-- Builder-or-above in a workspace (form management floor per the domain matrix:
-- form create/update/delete = builder; publish rides on update).
CREATE OR REPLACE FUNCTION formos.is_builder_or_above(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.role_rank(formos.my_role(p_workspace_id)) >= 2;
$$;

-- ---------------------------------------------------------------- forms
CREATE TABLE public.forms (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision >= 1),
  -- Canonical FORMOS document (validated app-side before every write; never raw JSON).
  draft_payload JSONB NOT NULL,
  created_by UUID,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);
CREATE INDEX forms_workspace_idx ON public.forms (workspace_id);
CREATE INDEX forms_workspace_status_idx ON public.forms (workspace_id, status);
CREATE TRIGGER forms_updated_at
  BEFORE UPDATE ON public.forms
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER forms_workspace_immutable
  BEFORE UPDATE ON public.forms
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forms FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.forms FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.forms TO authenticated;

-- Members read forms in their workspace (viewer floor per the domain matrix).
CREATE POLICY forms_member_read ON public.forms
  FOR SELECT TO PUBLIC USING (formos.is_member(workspace_id));
-- Builder+ manage drafts (create/update/delete). Canonical-shape validation and
-- optimistic concurrency are enforced server-side; RLS remains the tenant/role floor.
CREATE POLICY forms_builder_insert ON public.forms
  FOR INSERT TO PUBLIC WITH CHECK (formos.is_builder_or_above(workspace_id));
CREATE POLICY forms_builder_update ON public.forms
  FOR UPDATE TO PUBLIC
  USING (formos.is_builder_or_above(workspace_id))
  WITH CHECK (formos.is_builder_or_above(workspace_id));
CREATE POLICY forms_builder_delete ON public.forms
  FOR DELETE TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- form_versions (immutable)
CREATE TABLE public.form_versions (
  id UUID PRIMARY KEY,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  published_version_no INTEGER NOT NULL CHECK (published_version_no >= 1),
  -- Self-contained canonical snapshot: renders without reading the mutable draft.
  schema_snapshot JSONB NOT NULL,
  schema_version INTEGER NOT NULL,
  schema_hash TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  publisher_id UUID,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, published_version_no)
);
CREATE INDEX form_versions_form_idx ON public.form_versions (form_id, published_version_no DESC);
CREATE INDEX form_versions_workspace_idx ON public.form_versions (workspace_id);

ALTER TABLE public.form_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_versions FROM anon, authenticated;
GRANT SELECT ON public.form_versions TO authenticated;

-- Members read published versions in their workspace. No INSERT/UPDATE/DELETE
-- policies exist — inserts flow through formos.publish_form; updates and deletes
-- are additionally blocked by trigger (defense in depth, incl. table owners).
CREATE POLICY form_versions_member_read ON public.form_versions
  FOR SELECT TO PUBLIC USING (formos.is_member(workspace_id));

CREATE OR REPLACE FUNCTION formos.prevent_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'published versions are immutable (rollback = republish)';
  RETURN NULL;
END;
$$;

CREATE TRIGGER form_versions_immutable
  BEFORE UPDATE OR DELETE ON public.form_versions
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_version_mutation();

-- ---------------------------------------------------------------- publish RPC
-- Atomic publish: row-locks the form (serializes concurrent publishers),
-- re-checks the expected draft revision (OCC), mints the next version number
-- (UNIQUE backstop), and stores the server-validated canonical snapshot.
-- Canonical validation happens server-side (TypeScript) before this call;
-- the RPC enforces tenancy, role floor, revision match, and numbering.
CREATE OR REPLACE FUNCTION formos.publish_form(
  p_version_id UUID,
  p_form_id UUID,
  p_snapshot JSONB,
  p_schema_version INTEGER,
  p_schema_hash TEXT,
  p_renderer_version TEXT,
  p_publisher UUID,
  p_expected_revision INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_workspace UUID;
  v_revision INTEGER;
  v_next INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT f.workspace_id, f.draft_revision INTO v_workspace, v_revision
  FROM public.forms f WHERE f.id = p_form_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'form not found';
  END IF;
  IF NOT formos.is_builder_or_above(v_workspace) THEN
    RAISE EXCEPTION 'builder required';
  END IF;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'draft conflict: expected revision %, current %', p_expected_revision, v_revision;
  END IF;
  SELECT COALESCE(max(v.published_version_no), 0) + 1 INTO v_next
  FROM public.form_versions v WHERE v.form_id = p_form_id;
  INSERT INTO public.form_versions
    (id, form_id, workspace_id, published_version_no, schema_snapshot,
     schema_version, schema_hash, renderer_version, publisher_id)
  VALUES
    (p_version_id, p_form_id, v_workspace, v_next, p_snapshot,
     p_schema_version, p_schema_hash, p_renderer_version, p_publisher);
  RETURN v_next;
END;
$$;
REVOKE ALL ON FUNCTION formos.publish_form(UUID, UUID, JSONB, INTEGER, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.publish_form(UUID, UUID, JSONB, INTEGER, TEXT, TEXT, UUID, INTEGER) TO authenticated;

-- ---------------------------------------------------------------- public wrapper (PostgREST surface)
-- Hosted PostgREST serves the `public` schema only (see 0004): the thin
-- wrapper delegates 1:1 to the frozen DEFINER implementation. Same pinned
-- search_path, same least-privilege EXECUTE grant, no logic of its own.
CREATE OR REPLACE FUNCTION public.publish_form(
  p_version_id UUID,
  p_form_id UUID,
  p_snapshot JSONB,
  p_schema_version INTEGER,
  p_schema_hash TEXT,
  p_renderer_version TEXT,
  p_publisher UUID,
  p_expected_revision INTEGER
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT formos.publish_form(
    p_version_id, p_form_id, p_snapshot, p_schema_version,
    p_schema_hash, p_renderer_version, p_publisher, p_expected_revision
  );
$$;
REVOKE ALL ON FUNCTION public.publish_form(UUID, UUID, JSONB, INTEGER, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_form(UUID, UUID, JSONB, INTEGER, TEXT, TEXT, UUID, INTEGER) TO authenticated;
