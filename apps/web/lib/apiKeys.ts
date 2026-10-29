"use server";
import "server-only";
import { generateApiKey, hashApiKey, isValidScope, uuidv7, type ApiScope } from "@formos/database";
import { can, DomainError } from "@formos/domain";
import { revalidatePath } from "next/cache";
import { getMembership, requireUser } from "./identity";
import { supabaseServer } from "./supabaseServer";
import { writeAudit } from "./audit";

/**
 * API key management (Phase 9). Owner/admin only (api_key.* floor = admin).
 * The plaintext secret exists only in the create-action return value —
 * it is never persisted, logged, or returned again.
 */

const MAX_NAME = 80;

function fail(message: string): never {
  throw new DomainError({ code: "forbidden", message });
}

export interface ApiKeyMeta {
  id: string;
  prefix: string;
  name: string;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export async function listApiKeysAction(workspaceId: string): Promise<ApiKeyMeta[]> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "api_key", "read")) {
    fail("Not authorized to manage API keys.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("list_api_keys", { p_workspace_id: workspaceId });
  if (error) throw new DomainError({ code: "internal", message: "Could not list API keys." });
  return (data ?? []) as ApiKeyMeta[];
}

export interface CreatedApiKey extends ApiKeyMeta {
  secret: string;
}

export async function createApiKeyAction(input: {
  workspaceId: string;
  name: string;
  scopes: string[];
}): Promise<CreatedApiKey> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "api_key", "create")) {
    fail("Not authorized to create API keys.");
  }
  const name = input.name.trim().slice(0, MAX_NAME);
  const scopes = [...new Set(input.scopes)].filter((s): s is ApiScope => isValidScope(s));
  if (scopes.length === 0) fail("Select at least one scope.");
  const { fullKey, prefix } = generateApiKey();
  const secretHash = hashApiKey(fullKey);
  const supabase = await supabaseServer();
  const keyId = uuidv7();
  const { data, error } = await supabase.rpc("create_api_key", {
    p_id: keyId,
    p_workspace_id: membership.workspaceId,
    p_prefix: prefix,
    p_secret_hash: secretHash,
    p_name: name,
    p_scopes: scopes,
  });
  if (error) throw new DomainError({ code: "internal", message: "Could not create API key." });
  const created = (data as { id: string; workspace_id: string; prefix: string; name: string; scopes: string[]; created_at: string; revoked_at: null; last_used_at: null }) ?? null;
  if (!created) throw new DomainError({ code: "internal", message: "Could not create API key." });
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "api_key.created",
    resourceType: "api_key",
    resourceId: created.id,
    diff: { prefix, name: created.name, scopes: created.scopes },
  });
  revalidatePath(`/app/${membership.workspaceId}`);
  return { ...created, last_used_at: null, secret: fullKey };
}

export async function revokeApiKeyAction(input: { workspaceId: string; keyId: string }): Promise<{ ok: true }> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.");
  if (!can({ userId: user.id, workspaceRole: membership.role, grants: [], assignments: [] }, "api_key", "delete")) {
    fail("Not authorized to revoke API keys.");
  }
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("revoke_api_key", { p_key_id: input.keyId });
  if (error) throw new DomainError({ code: "internal", message: "Could not revoke API key." });
  const receipt = (data ?? {}) as { id?: string; prefix?: string };
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "api_key.revoked",
    resourceType: "api_key",
    resourceId: input.keyId,
    diff: { prefix: receipt.prefix ?? null },
  });
  revalidatePath(`/app/${membership.workspaceId}`);
  return { ok: true };
}
