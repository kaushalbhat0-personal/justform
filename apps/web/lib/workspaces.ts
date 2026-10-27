"use server";
import "server-only";
import { uuidv7 } from "@formos/database";
import { can, DomainError, type WorkspaceRole } from "@formos/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { writeAudit } from "./audit";
import { getMembership, listMyMemberships, requireUser } from "./identity";
import { generateInvitationToken, hashInvitationToken, invitationLink } from "./inviteToken";
import { supabaseServer } from "./supabaseServer";
import { serverEnv } from "./env";

const VALID_ROLES: WorkspaceRole[] = ["owner", "admin", "builder", "data_collaborator", "viewer"];

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "workspace";
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

/** Ensure the caller's profile row exists (self-provisioning, idempotent). */
function fail(message: string): never {
  throw new DomainError({ code: "forbidden", message });
}

export async function ensureProfile(displayName?: string): Promise<void> {
  const user = await requireUser();
  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("profiles")
    .upsert({ id: user.id, email: user.email ?? "", display_name: displayName ?? null }, { onConflict: "id" });
  if (error) throw new Error(`profile provisioning failed: ${error.message}`);
}

export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Workspace name is required.");
  const supabase = await supabaseServer();
  const wsId = uuidv7();
  const { error } = await supabase.rpc("create_workspace", {
    p_id: wsId,
    p_membership_id: uuidv7(),
    p_name: name,
    p_slug: `${slugify(name)}-${wsId.slice(0, 8)}`,
  });
  if (error) fail(asError(error));
  await writeAudit({ workspaceId: wsId, actorId: user.id, actorType: "user", action: "workspace.created", resourceType: "workspace", resourceId: wsId });
  revalidatePath("/app");
  redirect(`/app/${wsId}`);
}

export async function setRoleAction(workspaceId: string, targetUserId: string, role: WorkspaceRole): Promise<void> {
  const membership = await getMembership(workspaceId);
  if (!membership || !can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "member", "update")) {
    fail("Not authorized.");
  }
  if (!VALID_ROLES.includes(role)) fail("Unknown role.");
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("set_role", { p_workspace_id: workspaceId, p_target_user: targetUserId, p_role: role });
  if (error) fail(asError(error));
  await writeAudit({ workspaceId, actorId: membership.id, actorType: "user", action: "member.role_changed", resourceType: "membership", resourceId: targetUserId, diff: { role } });
  revalidatePath(`/app/${workspaceId}`);
}

export async function removeMemberAction(workspaceId: string, targetUserId: string): Promise<void> {
  const membership = await getMembership(workspaceId);
  if (!membership || !can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "member", "delete")) {
    fail("Not authorized.");
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("remove_member", { p_workspace_id: workspaceId, p_target_user: targetUserId });
  if (error) fail(asError(error));
  await writeAudit({ workspaceId, actorId: membership.id, actorType: "user", action: "member.removed", resourceType: "membership", resourceId: targetUserId });
  revalidatePath(`/app/${workspaceId}`);
}

export async function inviteAction(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<{ ok: true; link: string } | { ok: false; error: string }> {
  const membership = await getMembership(workspaceId);
  if (!membership || !can({ userId: membership.id, workspaceRole: membership.role, grants: [], assignments: [] }, "member", "create")) {
    return { ok: false, error: "Not authorized." };
  }
  if (!VALID_ROLES.includes(role) || role === "owner") return { ok: false, error: "Owners are added via transfer only." };
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return { ok: false, error: "Invalid email." };
  const { token, hash } = generateInvitationToken();
  const supabase = await supabaseServer();
  const inviteId = uuidv7();
  const { error } = await supabase.from("invitations").insert({
    id: inviteId,
    workspace_id: workspaceId,
    email: clean,
    role,
    token_hash: hash,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });
  if (error) return { ok: false, error: asError(error) };
  await writeAudit({ workspaceId, actorId: membership.id, actorType: "user", action: "member.invited", resourceType: "invitation", resourceId: inviteId, diff: { email: clean, role } });
  revalidatePath(`/app/${workspaceId}`);
  // Phase 1: the link is shown ONCE to the inviter (email delivery arrives later).
  // The raw token is never logged, persisted, or audited — only its hash is stored.
  return { ok: true, link: invitationLink(serverEnv().APP_URL, token) };
}

export async function acceptAction(token: string): Promise<{ ok: true; workspaceId: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("accept_invitation", {
    p_token_hash: hashInvitationToken(token.trim()),
    p_membership_id: uuidv7(),
  });
  if (error) return { ok: false, error: "This invitation is invalid or expired." };
  const workspaceId = data as string;
  await writeAudit({ workspaceId, actorId: user.id, actorType: "user", action: "member.invite_accepted", resourceType: "membership", resourceId: user.id });
  revalidatePath("/app");
  return { ok: true, workspaceId };
}

export { listMyMemberships };
