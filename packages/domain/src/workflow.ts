/**
 * Canonical workflow domain (FORMOS-IMPL-011).
 * Pure state machine — no I/O, no framework imports.
 * Single source of truth for workflow vocabulary; SQL RPCs and UI adapters
 * mirror these transitions and never re-implement them.
 */

export const WORKFLOW_DEFINITION_STATUSES = ["draft", "active", "archived"] as const;
export type WorkflowDefinitionStatus = (typeof WORKFLOW_DEFINITION_STATUSES)[number];

export const WORKFLOW_INSTANCE_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
] as const;
export type WorkflowInstanceStatus = (typeof WORKFLOW_INSTANCE_STATUSES)[number];

export const WORKFLOW_TASK_STATUSES = ["pending", "claimed", "completed", "cancelled"] as const;
export type WorkflowTaskStatus = (typeof WORKFLOW_TASK_STATUSES)[number];

export const APPROVAL_OUTCOMES = ["pending", "approved", "rejected", "cancelled"] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];

/** Minimal deterministic config: trigger + single approval step. */
export interface WorkflowConfig {
  trigger: "submission.created";
  steps: [{ type: "approval"; key: "approval"; assignee: "member" | "unassigned" }];
}

export interface WorkflowConfigValidation {
  ok: boolean;
  errors: string[];
}

/** Validate raw JSONB config at every boundary (BFF Zod + RPC CHECK + domain). */
export function validateWorkflowConfig(raw: unknown): WorkflowConfigValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["config must be an object"] };
  }
  const cfg = raw as Record<string, unknown>;
  if (cfg["trigger"] !== "submission.created") errors.push("trigger must be submission.created");
  const steps = cfg["steps"];
  if (!Array.isArray(steps) || steps.length !== 1) {
    errors.push("steps must contain exactly one approval step");
    return { ok: false, errors };
  }
  const step = steps[0] as Record<string, unknown>;
  if (step["type"] !== "approval") errors.push("step type must be approval");
  if (step["key"] !== "approval") errors.push("step key must be approval");
  if (step["assignee"] !== "member" && step["assignee"] !== "unassigned") {
    errors.push("step assignee must be member or unassigned");
  }
  return { ok: errors.length === 0, errors };
}

/** Normalize to canonical shape after validation. */
export function normalizeWorkflowConfig(raw: unknown): WorkflowConfig {
  const v = validateWorkflowConfig(raw);
  if (!v.ok) throw new Error(`invalid workflow config: ${v.errors.join("; ")}`);
  const cfg = raw as { steps: [{ assignee: "member" | "unassigned" }] };
  return {
    trigger: "submission.created",
    steps: [{ type: "approval", key: "approval", assignee: cfg.steps[0].assignee }],
  };
}

export function canTransitionTask(
  from: WorkflowTaskStatus,
  action: "claim" | "release" | "complete" | "cancel",
): boolean {
  switch (action) {
    case "claim":
      return from === "pending";
    case "release":
      return from === "claimed";
    case "complete":
      return from === "pending" || from === "claimed";
    case "cancel":
      return from === "pending" || from === "claimed";
  }
}

export function canDecideTask(from: WorkflowTaskStatus): boolean {
  return from === "pending" || from === "claimed";
}

export function instanceStatusForOutcome(outcome: "approved" | "rejected"): WorkflowInstanceStatus {
  return outcome === "approved" ? "completed" : "rejected";
}

/** Permission floors (mirror authorization.ts matrix; workflow.* already in matrix). */
export const WORKFLOW_ROLE_FLOOR = {
  manage: "builder", // create/update/activate/start/claim/assign/decide
  archive: "admin", // archive/cancel
} as const;
