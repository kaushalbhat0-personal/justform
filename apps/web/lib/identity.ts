import "server-only";
import { getSessionUser, type SessionUser } from "@formos/auth";
import type { WorkspaceRole } from "@formos/domain";
import { redirect } from "next/navigation";
import { supabaseServer } from "./supabaseServer";

export interface Membership {
  workspaceId: string;
  role: WorkspaceRole;
}

/** Canonical identity: session user or redirect to login. Never trusts client input. */
export async function requireUser(): Promise<SessionUser> {
  const supabase = await supabaseServer();
  const user = await getSessionUser(supabase);
  if (!user) redirect("/login");
  return user;
}

interface MembershipRow {
  workspace_id: string;
  role: WorkspaceRole;
}

/** Load the caller's membership; uniform null on miss (no cross-workspace oracle). */
export async function getMembership(workspaceId: string): Promise<(SessionUser & Membership) | null> {
  const user = await requireUser();
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("memberships")
    .select("workspace_id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as MembershipRow;
  return { ...user, workspaceId: row.workspace_id, role: row.role };
}

/** All workspaces the caller belongs to (switcher + landing). */
export async function listMyMemberships(): Promise<Array<{ workspaceId: string; role: WorkspaceRole; name: string; slug: string }>> {
  const user = await requireUser();
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("memberships")
    .select("workspace_id, role, workspaces(id, name, slug)")
    .eq("user_id", user.id);
  if (error || !data) return [];
  return (data as Array<{ workspace_id: string; role: WorkspaceRole; workspaces: { name: string; slug: string } | null }>).map(
    (m) => ({ workspaceId: m.workspace_id, role: m.role, name: m.workspaces?.name ?? "Workspace", slug: m.workspaces?.slug ?? "" }),
  );
}
