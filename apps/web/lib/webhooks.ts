"use server";
import "server-only";
import { encryptWebhookSecret, uuidv7 } from "@formos/database";
import { can, DomainError } from "@formos/domain";
import { revalidatePath } from "next/cache";
import { getMembership, requireUser } from "./identity";
import { supabaseServer } from "./supabaseServer";
import { writeAudit } from "./audit";

/**
 * Webhook endpoint management (Phase 9). Owner/admin only (integration.* floor).
 * Secrets are encrypted server-side before storage and never returned —
 * except the plaintext once, in memory, at creation/rotation time.
 */

const MAX_URL = 2048;
type WebhookEvent = "submission.created" | "submission.status_changed";

function fail(message: string): never {
  throw new DomainError({ code: "forbidden", message });
}

function checkOwnerAdmin(role: string | null, userId: string): void {
  if (!can({ userId, workspaceRole: role as never, grants: [], assignments: [] }, "integration", "create")) {
    fail("Not authorized to manage webhooks.");
  }
}

export interface WebhookMeta {
  id: string;
  form_id: string | null;
  url: string;
  events: string[];
  is_active: boolean;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  last_delivery: {
    status: string;
    response_code: number | null;
    attempts: number;
    delivered_at: string | null;
    created_at: string;
  } | null;
}

export async function listWebhooksAction(workspaceId: string): Promise<WebhookMeta[]> {
  const user = await requireUser();
  const membership = await getMembership(workspaceId);
  if (!membership) fail("Workspace not found.");
  checkOwnerAdmin(membership.role, user.id);
  const supabase = await supabaseServer();
  const { data, error } = await supabase.rpc("list_webhooks", { p_workspace_id: workspaceId });
  if (error) throw new DomainError({ code: "internal", message: "Could not list webhooks." });
  return (data ?? []) as WebhookMeta[];
}

export interface CreatedWebhook extends WebhookMeta {
  secret: string;
}

/** Generate a fresh signing secret (32 random bytes, base64url). */
function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validateEndpointInput(input: { url: unknown; events: unknown; formId?: unknown }): {
  url: string;
  events: WebhookEvent[];
  formId: string | null;
} {
  if (typeof input.url !== "string" || input.url.length < 1 || input.url.length > MAX_URL) {
    fail("Webhook URL must be 1–2048 characters.");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    fail("Webhook URL is not a valid absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail("Webhook URL must use http(s).");
  if (!Array.isArray(input.events) || input.events.length === 0) fail("Select at least one event.");
  const events = [...new Set(input.events)];
  for (const e of events) {
    if (e !== "submission.created" && e !== "submission.status_changed") fail(`Unsupported event: ${String(e)}.`);
  }
  let formId: string | null = null;
  if (input.formId !== undefined && input.formId !== null && input.formId !== "") {
    if (typeof input.formId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.formId)) {
      fail("Invalid form reference.");
    }
    formId = input.formId;
  }
  return { url: input.url, events: events as WebhookEvent[], formId };
}

export async function createWebhookAction(input: {
  workspaceId: string;
  url: string;
  events: string[];
  formId?: string | null;
}): Promise<CreatedWebhook> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.");
  checkOwnerAdmin(membership.role, user.id);
  const { url, events, formId } = validateEndpointInput({ url: input.url, events: input.events, formId: input.formId ?? null });
  const secret = generateWebhookSecret();
  const secretEnc = await encryptWebhookSecret(secret);
  const supabase = await supabaseServer();
  const id = uuidv7();
  const { data, error } = await supabase.rpc("create_webhook", {
    p_id: id,
    p_workspace_id: membership.workspaceId,
    p_form_id: formId,
    p_url: url,
    p_secret_enc: secretEnc,
    p_events: events,
  });
  if (error) throw new DomainError({ code: "internal", message: "Could not create webhook." });
  const created = data as { id: string } | null;
  if (!created) throw new DomainError({ code: "internal", message: "Could not create webhook." });
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "webhook.created",
    resourceType: "webhook_endpoint",
    resourceId: id,
    diff: { urlHost: safeHost(url), events, form_id: formId },
  });
  revalidatePath(`/app/${membership.workspaceId}`);
  const listed = await listWebhooksAction(membership.workspaceId);
  const meta = listed.find((w) => w.id === id);
  if (!meta) throw new DomainError({ code: "internal", message: "Could not create webhook." });
  return { ...meta, secret };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

export async function updateWebhookAction(input: {
  workspaceId: string;
  webhookId: string;
  url: string;
  events: string[];
  isActive: boolean;
}): Promise<{ ok: true }> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.");
  checkOwnerAdmin(membership.role, user.id);
  const { url, events } = validateEndpointInput({ url: input.url, events: input.events });
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("update_webhook", {
    p_id: input.webhookId,
    p_url: url,
    p_events: events,
    p_is_active: input.isActive,
  });
  if (error) throw new DomainError({ code: "internal", message: "Could not update webhook." });
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: input.isActive ? "webhook.updated" : "webhook.disabled",
    resourceType: "webhook_endpoint",
    resourceId: input.webhookId,
    diff: { urlHost: safeHost(url), events, is_active: input.isActive },
  });
  revalidatePath(`/app/${membership.workspaceId}`);
  return { ok: true };
}

export async function rotateWebhookSecretAction(input: { workspaceId: string; webhookId: string }): Promise<{ secret: string }> {
  const user = await requireUser();
  const membership = await getMembership(input.workspaceId);
  if (!membership) fail("Workspace not found.");
  checkOwnerAdmin(membership.role, user.id);
  const secret = generateWebhookSecret();
  const secretEnc = await encryptWebhookSecret(secret);
  const supabase = await supabaseServer();
  const { error } = await supabase.rpc("rotate_webhook_secret", { p_id: input.webhookId, p_secret_enc: secretEnc });
  if (error) throw new DomainError({ code: "internal", message: "Could not rotate webhook secret." });
  await writeAudit({
    workspaceId: membership.workspaceId,
    actorId: user.id,
    actorType: "user",
    action: "webhook.secret_rotated",
    resourceType: "webhook_endpoint",
    resourceId: input.webhookId,
  });
  revalidatePath(`/app/${membership.workspaceId}`);
  return { secret };
}
