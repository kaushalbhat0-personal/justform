"use server";
import "server-only";
import { can, type WorkspaceRole } from "@formos/domain";
import { revalidatePath } from "next/cache";
import { writeAudit } from "./audit";
import { getMembership, requireUser } from "./identity";
import { supabaseServer } from "./supabaseServer";
import { DomainError } from "@formos/domain";

function fail(message: string, code: "forbidden" | "not_found" = "forbidden"): never {
  throw new DomainError({ code, message });
}

interface Caller {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

async function requireCaller(workspaceId: string): Promise<Caller> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.", "not_found");
  return { userId: user.id, workspaceId: membership.workspaceId, role: membership.role };
}

function mapRpcError(error: { message: string }): never {
  const msg = error.message;
  if (/not found/i.test(msg)) fail("Workflow not found.", "not_found");
  if (/forbidden/i.test(msg)) fail("Not authorized for workflow action.");
  if (/conflict/i.test(msg)) fail("Task was already completed or changed. Refresh to see current state.");
  if (/already exists/i.test(msg)) fail("A workflow already exists for this form.");
  if (/invalid workflow config/i.test(msg)) fail("Invalid workflow configuration.");
  if (/only drafts/i.test(msg)) fail("Only draft workflows can be updated.");
  if (/archived workflows/i.test(msg)) fail("Archived workflows cannot be activated.");
  if (/no active workflow/i.test(msg)) fail("No active workflow for this submission.", "not_found");
  if (/assignee is not/i.test(msg)) fail("Assignee is not a workspace member.");
  throw new DomainError({ code: "internal", message: "Workflow action failed." });
}

export interface WorkflowDefinition {
  id: string;
  formId: string;
  status: string;
  currentVersionId: string | null;
  config: unknown;
}

export async function getWorkflowForForm(workspaceId: string, formId: string) {
  const caller = await requireCaller(workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "read")) {
    fail("Not authorized to view workflows.");
  }
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workflow_definitions")
    .select("id, form_id, status, current_version_id, config")
    .eq("workspace_id", caller.workspaceId)
    .eq("form_id", formId)
    .maybeSingle();
  return (data ?? null) as WorkflowDefinition | null;
}

export async function createWorkflowAction(input: { workspaceId: string; formId: string }) {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "create")) {
    fail("Not authorized to create workflows.");
  }
  const config = { trigger: "submission.created", steps: [{ type: "approval", key: "approval", assignee: "unassigned" }] } as const;
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("create_workflow_definition", {
    p_form_id: input.formId,
    p_config: config,
  });
  if (error) mapRpcError(error);
  await writeAudit({
    workspaceId: caller.workspaceId,
    actorId: caller.userId,
    actorType: "user",
    action: "workflow.created",
    resourceType: "workflow_definition",
    diff: { form_id: input.formId },
  }).catch(() => undefined);
  revalidatePath(`/app/${caller.workspaceId}/forms/${input.formId}`);
}

export async function activateWorkflowAction(input: { workspaceId: string; formId: string; definitionId: string }) {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "update")) {
    fail("Not authorized to activate workflows.");
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("activate_workflow", { p_definition_id: input.definitionId });
  if (error) mapRpcError(error);
  await writeAudit({
    workspaceId: caller.workspaceId,
    actorId: caller.userId,
    actorType: "user",
    action: "workflow.activated",
    resourceType: "workflow_definition",
    resourceId: input.definitionId,
    diff: { form_id: input.formId },
  }).catch(() => undefined);
  revalidatePath(`/app/${caller.workspaceId}/forms/${input.formId}`);
}

export async function archiveWorkflowAction(input: { workspaceId: string; formId: string; definitionId: string }) {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "delete")) {
    fail("Not authorized to archive workflows.");
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("archive_workflow", { p_definition_id: input.definitionId });
  if (error) mapRpcError(error);
  await writeAudit({
    workspaceId: caller.workspaceId,
    actorId: caller.userId,
    actorType: "user",
    action: "workflow.archived",
    resourceType: "workflow_definition",
    resourceId: input.definitionId,
  }).catch(() => undefined);
  revalidatePath(`/app/${caller.workspaceId}/forms/${input.formId}`);
}

export interface TaskView {
  id: string;
  instanceId: string;
  submissionId: string;
  status: string;
  outcome: string;
  assigneeUserId: string | null;
  claimedBy: string | null;
  instanceStatus: string;
}

export async function getTaskForSubmission(
  workspaceId: string,
  submissionId: string,
): Promise<TaskView | null> {
  const caller = await requireCaller(workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "read")) {
    fail("Not authorized to view workflows.");
  }
  const supabase = await supabaseServer();
  const { data: task } = await supabase
    .from("workflow_tasks")
    .select("id, instance_id, submission_id, status, outcome, assignee_user_id, claimed_by")
    .eq("workspace_id", caller.workspaceId)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (!task) return null;
  const t = task as Record<string, string | null>;
  const { data: inst } = await supabase
    .from("workflow_instances")
    .select("status")
    .eq("workspace_id", caller.workspaceId)
    .eq("id", t["instance_id"] as string)
    .maybeSingle();
  return {
    id: t["id"] as string,
    instanceId: t["instance_id"] as string,
    submissionId: t["submission_id"] as string,
    status: t["status"] as string,
    outcome: t["outcome"] as string,
    assigneeUserId: (t["assignee_user_id"] as string | null) ?? null,
    claimedBy: (t["claimed_by"] as string | null) ?? null,
    instanceStatus: ((inst as Record<string, string> | null)?.["status"] ?? "unknown") as string,
  };
}

/** Bounded task map for inbox rows (single IN query, no N+1). */
export async function getTasksForSubmissions(
  workspaceId: string,
  submissionIds: string[],
): Promise<Map<string, TaskView>> {
  const map = new Map<string, TaskView>();
  const ids = [...new Set(submissionIds)].slice(0, 100);
  if (ids.length === 0) return map;
  const caller = await requireCaller(workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "read")) {
    return map;
  }
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workflow_tasks")
    .select("id, instance_id, submission_id, status, outcome, assignee_user_id, claimed_by")
    .eq("workspace_id", caller.workspaceId)
    .in("submission_id", ids);
  for (const t of ((data ?? []) as Array<Record<string, string | null>>)) {
    map.set(t["submission_id"] as string, {
      id: t["id"] as string,
      instanceId: t["instance_id"] as string,
      submissionId: t["submission_id"] as string,
      status: t["status"] as string,
      outcome: t["outcome"] as string,
      assigneeUserId: (t["assignee_user_id"] as string | null) ?? null,
      claimedBy: (t["claimed_by"] as string | null) ?? null,
      instanceStatus: "",
    });
  }
  return map;
}

async function taskAction(
  caller: Caller,
  formId: string,
  fn: string,
  args: Record<string, string>,
  auditAction:
    | "workflow.task_claimed"
    | "workflow.task_released"
    | "workflow.task_assigned"
    | "workflow.task_approved"
    | "workflow.task_rejected"
    | "workflow.completed"
    | "workflow.cancelled"
    | "workflow.started",
  resourceId: string,
  diff?: Record<string, unknown>,
) {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) mapRpcError(error);
  await writeAudit({
    workspaceId: caller.workspaceId,
    actorId: caller.userId,
    actorType: "user",
    action: auditAction,
    resourceType: "workflow_task",
    resourceId,
    ...(diff !== undefined ? { diff } : {}),
  }).catch(() => undefined);
  revalidatePath(`/app/${caller.workspaceId}/forms/${formId}/submissions`);
  return data;
}

export async function claimTaskAction(input: { workspaceId: string; formId: string; taskId: string }) {
  const caller = await requireCaller(input.workspaceId);
  return taskAction(caller, input.formId, "claim_task", { p_task_id: input.taskId }, "workflow.task_claimed", input.taskId);
}

export async function releaseTaskAction(input: { workspaceId: string; formId: string; taskId: string }) {
  const caller = await requireCaller(input.workspaceId);
  return taskAction(caller, input.formId, "release_task", { p_task_id: input.taskId }, "workflow.task_released", input.taskId);
}

export async function assignTaskAction(input: {
  workspaceId: string;
  formId: string;
  taskId: string;
  assignee: string;
}) {
  const caller = await requireCaller(input.workspaceId);
  return taskAction(
    caller,
    input.formId,
    "assign_task",
    { p_task_id: input.taskId, p_assignee: input.assignee },
    "workflow.task_assigned",
    input.taskId,
    { assignee: input.assignee },
  );
}

export async function decideTaskAction(input: {
  workspaceId: string;
  formId: string;
  taskId: string;
  outcome: "approved" | "rejected";
}) {
  const caller = await requireCaller(input.workspaceId);
  return taskAction(
    caller,
    input.formId,
    "decide_task",
    { p_task_id: input.taskId, p_outcome: input.outcome },
    input.outcome === "approved" ? "workflow.task_approved" : "workflow.task_rejected",
    input.taskId,
    { outcome: input.outcome },
  );
}

export async function startWorkflowAction(input: { workspaceId: string; formId: string; submissionId: string }) {
  const caller = await requireCaller(input.workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "update")) {
    fail("Not authorized for workflow action.");
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("start_workflow", { p_submission_id: input.submissionId });
  if (error) mapRpcError(error);
  await writeAudit({
    workspaceId: caller.workspaceId,
    actorId: caller.userId,
    actorType: "user",
    action: "workflow.started",
    resourceType: "workflow_instance",
    resourceId: input.submissionId,
  }).catch(() => undefined);
  revalidatePath(`/app/${caller.workspaceId}/forms/${input.formId}/submissions`);
}

export async function listMyTasks(workspaceId: string) {
  const caller = await requireCaller(workspaceId);
  if (!can({ userId: caller.userId, workspaceRole: caller.role, grants: [], assignments: [] }, "workflow", "read")) {
    fail("Not authorized to view workflows.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("workflow_tasks")
    .select("id, instance_id, submission_id, status, outcome, assignee_user_id, claimed_by, created_at")
    .eq("workspace_id", caller.workspaceId)
    .in("status", ["pending", "claimed"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new DomainError({ code: "internal", message: "Could not list tasks." });
  return (data ?? []) as Array<Record<string, string | null>>;
}
