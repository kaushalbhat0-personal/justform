/**
 * Canonical audit event catalogue (foundation).
 * Producers are added per phase; the model + append-only contract are fixed now.
 */
export const AUDIT_ACTIONS = [
  "workspace.created",
  "member.invited",
  "member.invite_accepted",
  "member.role_changed",
  "member.removed",
  "grant.created",
  "grant.revoked",
  "form.created",
  "form.updated",
  "form.published",
  "form.unpublished",
  "form.deleted",
  "submission.assigned",
  "submission.status_changed",
  "submission.exported",
  "workflow.created",
  "workflow.activated",
  "workflow.archived",
  "workflow.started",
  "workflow.task_assigned",
  "workflow.task_claimed",
  "workflow.task_released",
  "workflow.task_approved",
  "workflow.task_rejected",
  "workflow.completed",
  "workflow.cancelled",
  "api_key.created",
  "api_key.revoked",
  "webhook.created",
  "webhook.updated",
  "webhook.disabled",
  "webhook.secret_rotated",
  "billing.plan_changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  workspaceId: string;
  actorId: string | null; // null = system/worker
  actorType: "user" | "api_key" | "system";
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  /** Minimal diff — never secrets, never full submission payloads. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ipHash?: string;
  requestId?: string;
  correlationId?: string;
}
