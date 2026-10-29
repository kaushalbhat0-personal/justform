-- FORMOS migration 0018 — workflow version pointer authority (IMPL-011 fix).
--
-- Live verification (workflow-live.mjs W6) exposed a contradiction in 0017:
-- `activate_workflow` and `archive_workflow` UPDATE rows in
-- public.workflow_versions to supersede/archive them, but workflow versions
-- are immutable (workflow_versions_immutable trigger, same rule as
-- form_versions). The second activation of any definition therefore raised
-- 'workflow versions are immutable' instead of versioning forward.
--
-- Resolution: the definition's current_version_id pointer is the SOLE active
-- marker (exactly like form_publications.form_version_id for form snapshots).
-- Version rows are insert-only; their status column records creation state
-- and is never mutated. The starter already resolves the version through the
-- pointer, so its redundant status predicate is dropped (pointer equality is
-- the authority). No data migration: existing rows already carry the correct
-- creation status, and every running instance pins its workflow_version_id.
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
  -- No supersede UPDATE: version rows are immutable. The pointer below is the
  -- only active marker; in-flight instances keep pinning their own version.
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

-- Archive flips the definition only. Version rows stay untouched
-- (immutability); the starter only starts definitions with status = 'active'.
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
  RETURN jsonb_build_object('id', v_def.id, 'status', 'archived');
END;
$$;
REVOKE ALL ON FUNCTION formos.archive_workflow(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION formos.archive_workflow(UUID) TO authenticated;

-- Starter: pointer equality is the authority (drop the redundant status
-- predicate so superseded-but-immutable rows can never confuse it).
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
  IF NOT FOUND THEN
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
