/**
 * Canonical authorization model (ADR-007).
 * ONE implementation location for role/permission evaluation.
 * This pure evaluator is used for fast-path UX gating AND mirrored by
 * database RLS policies — but it NEVER replaces RLS. Every data-protecting
 * decision is re-enforced server/database-side per request.
 */

export const WORKSPACE_ROLES = [
  "owner",
  "admin",
  "builder",
  "data_collaborator",
  "viewer",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Higher index = more privilege. */
const RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  data_collaborator: 1,
  builder: 2,
  admin: 3,
  owner: 4,
};

export type ResourceType =
  | "form"
  | "submission"
  | "table_view"
  | "workflow"
  | "report"
  | "integration"
  | "api_key"
  | "billing"
  | "workspace_admin"
  | "member";

export type Action =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "share"
  | "export";

export interface Grant {
  resourceType: ResourceType;
  resourceId: string;
  actions: Action[];
  /** Grants without expiry are rejected at the RPC layer; represented here as required. */
  expiresAt: string;
}

/** Minimum workspace role per (resource, action). Mirrors ADR-007 matrix. */
const MINIMUM_ROLE: Record<ResourceType, Partial<Record<Action, WorkspaceRole>>> = {
  form: { create: "builder", read: "viewer", update: "builder", delete: "builder", share: "builder" },
  submission: { create: "builder", read: "builder", update: "data_collaborator", delete: "admin", share: "builder", export: "builder" },
  table_view: { create: "builder", read: "viewer", update: "builder", delete: "builder", share: "builder" },
  workflow: { create: "builder", read: "builder", update: "builder", delete: "admin", share: "admin" },
  report: { create: "builder", read: "viewer", update: "builder", delete: "builder", share: "builder" },
  integration: { create: "admin", read: "builder", update: "admin", delete: "admin", share: "admin" },
  api_key: { create: "admin", read: "admin", update: "admin", delete: "admin" },
  billing: { create: "owner", read: "admin", update: "owner", delete: "owner" },
  workspace_admin: { read: "admin", update: "admin", delete: "owner" },
  member: { create: "admin", read: "viewer", update: "admin", delete: "admin" },
};

/** Submission collaborators may act on assigned rows even below the Builder read floor. */
export interface AssignmentScope {
  resourceType: "submission";
  resourceId: string;
  assigneeUserId: string;
}

export interface Principal {
  userId: string;
  workspaceRole: WorkspaceRole | null; // null = not a member
  grants: Grant[];
  assignments: AssignmentScope[];
}

export function hasRoleAtLeast(role: WorkspaceRole | null, minimum: WorkspaceRole): boolean {
  if (role === null) return false;
  return RANK[role] >= RANK[minimum];
}

/**
 * Pure permission check. Deny-by-default: unknown resource/action → false.
 * Viewer can never write/export/share/manage — enforced structurally here
 * (viewer rank fails every non-read minimum) and re-enforced in RLS.
 */
export function can(principal: Principal, resource: ResourceType, action: Action, resourceId?: string): boolean {
  // Invitations by role rank are handled by a dedicated invite rule (role <= own),
  // not by this matrix; member.create covers membership management.
  const minimum = MINIMUM_ROLE[resource]?.[action];
  if (minimum === undefined) return false;
  if (hasRoleAtLeast(principal.workspaceRole, minimum)) return true;

  // Assignment scope: assignees may read/update their assigned submissions.
  if (
    resource === "submission" &&
    (action === "read" || action === "update") &&
    resourceId !== undefined &&
    principal.assignments.some(
      (a) => a.resourceId === resourceId && a.assigneeUserId === principal.userId,
    )
  ) {
    return true;
  }

  // Explicit resource grants (RPC-minted, expiring — validated again in the DB).
  if (resourceId !== undefined) {
    const now = Date.now();
    return principal.grants.some(
      (g) =>
        g.resourceType === resource &&
        g.resourceId === resourceId &&
        g.actions.includes(action) &&
        Date.parse(g.expiresAt) > now,
    );
  }
  return false;
}

/** Invitation rule: inviter role must strictly outrank (or equal admin+) the granted role. */
export function canInvite(inviter: WorkspaceRole | null, invited: WorkspaceRole): boolean {
  if (inviter === null) return false;
  if (inviter === "owner") return true;
  if (inviter === "admin") return invited !== "owner";
  return false;
}
