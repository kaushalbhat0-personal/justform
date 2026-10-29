-- FORMOS migration 0017 — workflow + assignment + approval foundation (IMPL-011).
--
-- Model (minimal durable orchestration layer around submissions):
--   workflow_definitions — one draft container per form (draft/active/archived).
--   workflow_versions    — immutable snapshots activated from a draft (like form_versions).
--   workflow_instances   — one per submission entering an active workflow.
--   workflow_tasks       — one human approval step per instance (this phase).
--
-- Rules: portable SQL, zero extensions, pinned-search_path DEFINER, RLS
-- deny-by-default + FORCE, app-generated UUIDs, RPC-only writes (no DML
-- grants/policies on workflow tables), receipt-only outbox payloads, no
-- submission payload bytes in audit/outbox.
-- Single approval flow: Start → Approval → End. Config vocabulary is frozen
-- to {trigger: submission.created, steps:[{type:approval,key:approval}]}.

-- ---------------------------------------------------------------- definitions
CREATE TABLE public.workflow_definitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_version_id UUID,
  config JSONB NOT NULL DEFAULT '{"trigger":"submission.created","steps":[{"type":"approval","key":"approval","assignee":"unassigned"}]}'
    CHECK (jsonb_typeof(config) = 'object'),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id)
);
CREATE INDEX workflow_definitions_workspace_idx ON public.workflow_definitions (workspace_id);
CREATE TRIGGER workflow_definitions_updated_at
  BEFORE UPDATE ON public.workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER workflow_definitions_workspace_immutable
  BEFORE UPDATE ON public.workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_definitions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_definitions FROM anon, authenticated;
GRANT SELECT ON public.workflow_definitions TO authenticated;
CREATE POLICY workflow_definitions_builder_read ON public.workflow_definitions
  FOR SELECT TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- versions (immutable)
CREATE TABLE public.workflow_versions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  definition_id UUID NOT NULL REFERENCES public.workflow_definitions (id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version_no)
);
CREATE INDEX workflow_versions_workspace_idx ON public.workflow_versions (workspace_id);
CREATE INDEX workflow_versions_definition_idx ON public.workflow_versions (definition_id);

CREATE OR REPLACE FUNCTION formos.prevent_workflow_version_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'workflow versions are immutable';
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION formos.prevent_workflow_version_mutation() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER workflow_versions_immutable
  BEFORE UPDATE OR DELETE ON public.workflow_versions
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workflow_version_mutation();

ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_versions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_versions FROM anon, authenticated;
GRANT SELECT ON public.workflow_versions TO authenticated;
CREATE POLICY workflow_versions_builder_read ON public.workflow_versions
  FOR SELECT TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- instances
CREATE TABLE public.workflow_instances (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES public.forms (id) ON DELETE CASCADE,
  form_version_id UUID NOT NULL REFERENCES public.form_versions (id) ON DELETE CASCADE,
  submission_id UUID NOT NULL UNIQUE REFERENCES public.submissions (id) ON DELETE CASCADE,
  workflow_definition_id UUID NOT NULL REFERENCES public.workflow_definitions (id) ON DELETE CASCADE,
  workflow_version_id UUID NOT NULL REFERENCES public.workflow_versions (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'rejected', 'cancelled')),
  current_step TEXT NOT NULL DEFAULT 'approval',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX workflow_instances_workspace_idx ON public.workflow_instances (workspace_id);
CREATE INDEX workflow_instances_form_idx ON public.workflow_instances (form_id);
CREATE INDEX workflow_instances_status_idx ON public.workflow_instances (workspace_id, status);
CREATE TRIGGER workflow_instances_updated_at
  BEFORE UPDATE ON public.workflow_instances
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER workflow_instances_workspace_immutable
  BEFORE UPDATE ON public.workflow_instances
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_instances FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_instances FROM anon, authenticated;
GRANT SELECT ON public.workflow_instances TO authenticated;
CREATE POLICY workflow_instances_builder_read ON public.workflow_instances
  FOR SELECT TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- tasks
CREATE TABLE public.workflow_tasks (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES public.workflow_instances (id) ON DELETE CASCADE,
  submission_id UUID NOT NULL REFERENCES public.submissions (id) ON DELETE CASCADE,
  step_key TEXT NOT NULL DEFAULT 'approval',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'cancelled')),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'approved', 'rejected', 'cancelled')),
  assignee_user_id UUID,
  claimed_by UUID,
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX workflow_tasks_instance_idx ON public.workflow_tasks (instance_id);
CREATE INDEX workflow_tasks_workspace_status_idx ON public.workflow_tasks (workspace_id, status);
CREATE INDEX workflow_tasks_assignee_idx ON public.workflow_tasks (workspace_id, assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;
CREATE INDEX workflow_tasks_submission_idx ON public.workflow_tasks (submission_id);
CREATE TRIGGER workflow_tasks_updated_at
  BEFORE UPDATE ON public.workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION formos.set_updated_at();
CREATE TRIGGER workflow_tasks_workspace_immutable
  BEFORE UPDATE ON public.workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION formos.prevent_workspace_id_change();

ALTER TABLE public.workflow_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_tasks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.workflow_tasks FROM anon, authenticated;
GRANT SELECT ON public.workflow_tasks TO authenticated;
CREATE POLICY workflow_tasks_builder_read ON public.workflow_tasks
  FOR SELECT TO PUBLIC USING (formos.is_builder_or_above(workspace_id));

-- ---------------------------------------------------------------- config validation helper
CREATE OR REPLACE FUNCTION formos.workflow_config_valid(p_config JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN false;
  END IF;
  IF (p_config ->> 'trigger') <> 'submission.created' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(coalesce(p_config -> 'steps', '[]'::jsonb)) <> 1 THEN
    RETURN false;
  END IF;
  IF (p_config -> 'steps' -> 0 ->> 'type') <> 'approval' THEN
    RETURN false;
  END IF;
  IF (p_config -> 'steps' -> 0 ->> 'key') <> 'approval' THEN
    RETURN false;
  END IF;
  IF (p_config -> 'steps' -> 0 ->> 'assignee') NOT IN ('member', 'unassigned') THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION formos.workflow_config_valid(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.workflow_config_valid(JSONB) TO authenticated;

-- ---------------------------------------------------------------- create definition (draft)
CREATE OR REPLACE FUNCTION formos.create_workflow_definition(
  p_id UUID,
  p_form_id UUID,
  p_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_form public.forms%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_id IS NULL OR p_form_id IS NULL THEN
    RAISE EXCEPTION 'invalid workflow definition';
  END IF;
  IF NOT formos.workflow_config_valid(p_config) THEN
    RAISE EXCEPTION 'invalid workflow config';
  END IF;
  SELECT f.* INTO v_form FROM public.forms f WHERE f.id = p_form_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_form.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  PERFORM 1 FROM public.workflow_definitions d WHERE d.form_id = p_form_id;
  IF FOUND THEN
    RAISE EXCEPTION 'workflow already exists for form';
  END IF;
  INSERT INTO public.workflow_definitions (id, workspace_id, form_id, status, config, created_by)
  VALUES (p_id, v_form.workspace_id, p_form_id, 'draft', p_config, auth.uid());
  RETURN jsonb_build_object('id', p_id, 'form_id', p_form_id, 'status', 'draft');
END;
$$;
REVOKE ALL ON FUNCTION formos.create_workflow_definition(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.create_workflow_definition(UUID, UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------- update draft
CREATE OR REPLACE FUNCTION formos.update_workflow_draft(
  p_definition_id UUID,
  p_config JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_def public.workflow_definitions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT formos.workflow_config_valid(p_config) THEN
    RAISE EXCEPTION 'invalid workflow config';
  END IF;
  SELECT d.* INTO v_def FROM public.workflow_definitions d WHERE d.id = p_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_def.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_def.status <> 'draft' THEN
    RAISE EXCEPTION 'only drafts can be updated';
  END IF;
  UPDATE public.workflow_definitions SET config = p_config WHERE id = v_def.id;
  RETURN jsonb_build_object('id', v_def.id, 'status', 'draft');
END;
$$;
REVOKE ALL ON FUNCTION formos.update_workflow_draft(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.update_workflow_draft(UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------- activate (draft → versioned active)
CREATE OR REPLACE FUNCTION formos.activate_workflow(p_definition_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_def public.workflow_definitions%ROWTYPE;
  v_no INTEGER;
  v_version_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT d.* INTO v_def FROM public.workflow_definitions d WHERE d.id = p_definition_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_def.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_def.status = 'archived' THEN
    RAISE EXCEPTION 'archived workflows cannot be activated';
  END IF;
  SELECT coalesce(max(v.version_no), 0) + 1 INTO v_no
  FROM public.workflow_versions v WHERE v.definition_id = v_def.id;
  v_version_id := md5(v_def.id::text || ':' || v_no::text || ':' || clock_timestamp()::text)::uuid;
  INSERT INTO public.workflow_versions
    (id, workspace_id, definition_id, form_id, version_no, config, status, created_by)
  VALUES
    (v_version_id, v_def.workspace_id, v_def.id, v_def.form_id, v_no, v_def.config, 'active', auth.uid());
  UPDATE public.workflow_versions SET status = 'archived'
  WHERE definition_id = v_def.id AND id <> v_version_id AND status = 'active';
  UPDATE public.workflow_definitions
  SET status = 'active', current_version_id = v_version_id
  WHERE id = v_def.id;
  INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (md5('wf-act:' || v_version_id::text)::uuid, v_def.workspace_id,
    'workflow.activated', 'workflow_definition', v_def.id,
    jsonb_build_object('definition_id', v_def.id, 'version_no', v_no, 'form_id', v_def.form_id));
  RETURN jsonb_build_object('id', v_def.id, 'status', 'active', 'version_no', v_no, 'version_id', v_version_id);
END;
$$;
REVOKE ALL ON FUNCTION formos.activate_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.activate_workflow(UUID) TO authenticated;

-- ---------------------------------------------------------------- archive (admin+)
CREATE OR REPLACE FUNCTION formos.archive_workflow(p_definition_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_def public.workflow_definitions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT d.* INTO v_def FROM public.workflow_definitions d WHERE d.id = p_definition_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_def.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.workflow_definitions SET status = 'archived' WHERE id = v_def.id;
  UPDATE public.workflow_versions SET status = 'archived'
  WHERE definition_id = v_def.id AND status = 'active';
  RETURN jsonb_build_object('id', v_def.id, 'status', 'archived');
END;
$$;
REVOKE ALL ON FUNCTION formos.archive_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.archive_workflow(UUID) TO authenticated;

-- ---------------------------------------------------------------- internal starter (single txn helper)
CREATE OR REPLACE FUNCTION formos.start_workflow_for_submission(
  p_submission_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sub public.submissions%ROWTYPE;
  v_def public.workflow_definitions%ROWTYPE;
  v_ver public.workflow_versions%ROWTYPE;
  v_inst_id UUID;
  v_task_id UUID;
BEGIN
  SELECT s.* INTO v_sub FROM public.submissions s WHERE s.id = p_submission_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('started', false, 'reason', 'no_submission');
  END IF;
  PERFORM 1 FROM public.workflow_instances i WHERE i.submission_id = p_submission_id;
  IF FOUND THEN
    RETURN jsonb_build_object('started', false, 'reason', 'already_started');
  END IF;
  SELECT d.* INTO v_def FROM public.workflow_definitions d
  WHERE d.form_id = v_sub.form_id AND d.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('started', false, 'reason', 'no_active_workflow');
  END IF;
  IF v_def.current_version_id IS NULL THEN
    RETURN jsonb_build_object('started', false, 'reason', 'no_active_version');
  END IF;
  SELECT v.* INTO v_ver FROM public.workflow_versions v WHERE v.id = v_def.current_version_id;
  IF NOT FOUND OR v_ver.status <> 'active' THEN
    RETURN jsonb_build_object('started', false, 'reason', 'no_active_version');
  END IF;
  v_inst_id := md5('wf-inst:' || p_submission_id::text)::uuid;
  v_task_id := md5('wf-task:' || p_submission_id::text)::uuid;
  INSERT INTO public.workflow_instances
    (id, workspace_id, form_id, form_version_id, submission_id, workflow_definition_id, workflow_version_id, status, current_step)
  VALUES
    (v_inst_id, v_sub.workspace_id, v_sub.form_id, v_sub.form_version_id, v_sub.id, v_def.id, v_ver.id, 'in_progress', 'approval')
  ON CONFLICT (submission_id) DO NOTHING;
  INSERT INTO public.workflow_tasks
    (id, workspace_id, instance_id, submission_id, step_key, status, outcome)
  VALUES
    (v_task_id, v_sub.workspace_id, v_inst_id, v_sub.id, 'approval', 'pending', 'pending')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES
    (md5('wf-started:' || p_submission_id::text)::uuid, v_sub.workspace_id,
     'workflow.started', 'workflow_instance', v_inst_id,
     jsonb_build_object('instance_id', v_inst_id, 'submission_id', v_sub.id, 'form_id', v_sub.form_id)),
    (md5('wf-task:' || p_submission_id::text)::uuid, v_sub.workspace_id,
     'workflow.task.created', 'workflow_task', v_task_id,
     jsonb_build_object('task_id', v_task_id, 'instance_id', v_inst_id, 'submission_id', v_sub.id))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('started', true, 'instance_id', v_inst_id, 'task_id', v_task_id);
END;
$$;
REVOKE ALL ON FUNCTION formos.start_workflow_for_submission(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.start_workflow_for_submission(UUID) TO intake_caller;
GRANT EXECUTE ON FUNCTION formos.start_workflow_for_submission(UUID) TO service_role;

-- ---------------------------------------------------------------- member manual start (backfill)
CREATE OR REPLACE FUNCTION formos.start_workflow(p_submission_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_sub public.submissions%ROWTYPE;
  v_out JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT s.* INTO v_sub FROM public.submissions s WHERE s.id = p_submission_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_sub.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT formos.start_workflow_for_submission(p_submission_id) INTO v_out;
  IF NOT coalesce((v_out ->> 'started')::boolean, false) THEN
    IF (v_out ->> 'reason') = 'already_started' THEN
      RETURN v_out;
    END IF;
    RAISE EXCEPTION 'no active workflow';
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION formos.start_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.start_workflow(UUID) TO authenticated;

-- ---------------------------------------------------------------- claim / release / assign
CREATE OR REPLACE FUNCTION formos.claim_task(p_task_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_t public.workflow_tasks%ROWTYPE;
  v_updated public.workflow_tasks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT t.* INTO v_t FROM public.workflow_tasks t WHERE t.id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_t.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_t.status = 'claimed' AND v_t.claimed_by = auth.uid() THEN
    RETURN jsonb_build_object('id', v_t.id, 'status', 'claimed', 'changed', false);
  END IF;
  UPDATE public.workflow_tasks
  SET status = 'claimed', claimed_by = auth.uid(), assignee_user_id = coalesce(assignee_user_id, auth.uid())
  WHERE id = p_task_id AND status = 'pending'
  RETURNING * INTO v_updated;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (md5('wf-claim:' || p_task_id::text || ':' || auth.uid()::text)::uuid, v_t.workspace_id,
    'workflow.task.assigned', 'workflow_task', p_task_id,
    jsonb_build_object('task_id', p_task_id, 'claimed_by', auth.uid()))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id', v_updated.id, 'status', 'claimed', 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.claim_task(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.claim_task(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION formos.release_task(p_task_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_t public.workflow_tasks%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT t.* INTO v_t FROM public.workflow_tasks t WHERE t.id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_t.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_t.status <> 'claimed' THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  IF v_t.claimed_by <> auth.uid() AND formos.role_rank(formos.my_role(v_t.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.workflow_tasks
  SET status = 'pending', claimed_by = NULL, assignee_user_id = NULL
  WHERE id = p_task_id AND status = 'claimed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  RETURN jsonb_build_object('id', p_task_id, 'status', 'pending', 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.release_task(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.release_task(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION formos.assign_task(p_task_id UUID, p_assignee UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_t public.workflow_tasks%ROWTYPE;
  v_rank INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_assignee IS NULL THEN
    RAISE EXCEPTION 'invalid assignee';
  END IF;
  SELECT t.* INTO v_t FROM public.workflow_tasks t WHERE t.id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  v_rank := formos.role_rank(formos.my_role(v_t.workspace_id));
  IF v_rank < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_t.status NOT IN ('pending', 'claimed') THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  PERFORM 1 FROM public.memberships m
  WHERE m.workspace_id = v_t.workspace_id AND m.user_id = p_assignee AND m.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignee is not a workspace member';
  END IF;
  UPDATE public.workflow_tasks
  SET assignee_user_id = p_assignee, assigned_at = now()
  WHERE id = p_task_id AND status IN ('pending', 'claimed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES (md5('wf-assign:' || p_task_id::text || ':' || p_assignee::text)::uuid, v_t.workspace_id,
    'workflow.task.assigned', 'workflow_task', p_task_id,
    jsonb_build_object('task_id', p_task_id, 'assignee', p_assignee))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id', p_task_id, 'assignee', p_assignee, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.assign_task(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.assign_task(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------- approve / reject (atomic, concurrency-safe)
CREATE OR REPLACE FUNCTION formos.decide_task(p_task_id UUID, p_outcome TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_t public.workflow_tasks%ROWTYPE;
  v_inst public.workflow_instances%ROWTYPE;
  v_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_outcome NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid outcome';
  END IF;
  SELECT t.* INTO v_t FROM public.workflow_tasks t WHERE t.id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_t.workspace_id)) < 2 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT i.* INTO v_inst FROM public.workflow_instances i WHERE i.id = v_t.instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF v_inst.status IN ('completed', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  UPDATE public.workflow_tasks
  SET status = 'completed', outcome = p_outcome, decided_by = auth.uid(),
      decided_at = now(), completed_at = now()
  WHERE id = p_task_id AND status IN ('pending', 'claimed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  v_status := CASE WHEN p_outcome = 'approved' THEN 'completed' ELSE 'rejected' END;
  UPDATE public.workflow_instances
  SET status = v_status, completed_at = now()
  WHERE id = v_inst.id;
  INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
  VALUES
    (md5('wf-decide:' || p_task_id::text)::uuid, v_t.workspace_id,
     'workflow.task.completed', 'workflow_task', p_task_id,
     jsonb_build_object('task_id', p_task_id, 'outcome', p_outcome, 'decided_by', auth.uid())),
    (md5('wf-done:' || v_inst.id::text)::uuid, v_t.workspace_id,
     'workflow.completed', 'workflow_instance', v_inst.id,
     jsonb_build_object('instance_id', v_inst.id, 'status', v_status, 'submission_id', v_t.submission_id))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('id', p_task_id, 'outcome', p_outcome, 'instance_status', v_status, 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.decide_task(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.decide_task(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------- cancel instance (admin+)
CREATE OR REPLACE FUNCTION formos.cancel_workflow(p_instance_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_inst public.workflow_instances%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT i.* INTO v_inst FROM public.workflow_instances i WHERE i.id = p_instance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found';
  END IF;
  IF formos.role_rank(formos.my_role(v_inst.workspace_id)) < 3 THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF v_inst.status IN ('completed', 'rejected', 'cancelled') THEN
    RAISE EXCEPTION 'conflict';
  END IF;
  UPDATE public.workflow_instances SET status = 'cancelled', completed_at = now() WHERE id = v_inst.id;
  UPDATE public.workflow_tasks SET status = 'cancelled', outcome = 'cancelled', completed_at = now()
  WHERE instance_id = v_inst.id AND status IN ('pending', 'claimed');
  RETURN jsonb_build_object('id', v_inst.id, 'status', 'cancelled', 'changed', true);
END;
$$;
REVOKE ALL ON FUNCTION formos.cancel_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.cancel_workflow(UUID) TO authenticated;

-- ---------------------------------------------------------------- PostgREST wrappers (member control plane)
CREATE OR REPLACE FUNCTION public.create_workflow_definition(p_form_id UUID, p_config JSONB)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.create_workflow_definition(md5('wf-def:' || p_form_id::text)::uuid, p_form_id, p_config); $$;
REVOKE ALL ON FUNCTION public.create_workflow_definition(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_workflow_definition(UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_workflow_draft(p_definition_id UUID, p_config JSONB)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.update_workflow_draft(p_definition_id, p_config); $$;
REVOKE ALL ON FUNCTION public.update_workflow_draft(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_workflow_draft(UUID, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.activate_workflow(p_definition_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.activate_workflow(p_definition_id); $$;
REVOKE ALL ON FUNCTION public.activate_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_workflow(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.archive_workflow(p_definition_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.archive_workflow(p_definition_id); $$;
REVOKE ALL ON FUNCTION public.archive_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_workflow(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_workflow(p_submission_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.start_workflow(p_submission_id); $$;
REVOKE ALL ON FUNCTION public.start_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_workflow(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_task(p_task_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.claim_task(p_task_id); $$;
REVOKE ALL ON FUNCTION public.claim_task(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_task(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.release_task(p_task_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.release_task(p_task_id); $$;
REVOKE ALL ON FUNCTION public.release_task(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_task(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.assign_task(p_task_id UUID, p_assignee UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.assign_task(p_task_id, p_assignee); $$;
REVOKE ALL ON FUNCTION public.assign_task(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task(UUID, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_task(p_task_id UUID, p_outcome TEXT)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.decide_task(p_task_id, p_outcome); $$;
REVOKE ALL ON FUNCTION public.decide_task(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_task(UUID, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_workflow(p_instance_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT formos.cancel_workflow(p_instance_id); $$;
REVOKE ALL ON FUNCTION public.cancel_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_workflow(UUID) TO authenticated;

-- ---------------------------------------------------------------- atomic intake autostart
-- Preserves the frozen 0014 intake transaction (quota, idempotency, caps,
-- metering) and adds workflow initialization atomically: submission + outbox
-- + usage + instance + task commit together. No second write path.
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
  v_wf JSONB;
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

  INSERT INTO public.usage_events
    (id, workspace_id, metric, quantity, source, source_id, period_start)
  VALUES
    (formos.new_uuid(), v_pub.workspace_id, 'submission', 1, 'intake', p_submission_id::text,
     formos.period_start((SELECT w.billing_period_start FROM public.workspaces w WHERE w.id = v_pub.workspace_id), now()))
  ON CONFLICT (workspace_id, metric, source, source_id) DO NOTHING;

  -- Workflow autostart: same transaction, receipt-only events, never fails
  -- intake when no active workflow exists (starter returns started=false).
  SELECT formos.start_workflow_for_submission(p_submission_id) INTO v_wf;

  RETURN jsonb_build_object('submission_id', p_submission_id, 'duplicate', false, 'status', 'received',
    'workflow_started', coalesce((v_wf ->> 'started')::boolean, false));
END;
$$;
REVOKE ALL ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA formos TO intake_caller;
GRANT EXECUTE ON FUNCTION formos.submit_submission(TEXT, UUID, JSONB, TEXT) TO intake_caller;
