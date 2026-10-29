/**
 * Webhook event envelope (Phase 9).
 * Minimal, versioned, explicit. Payload carries receipt-level metadata only —
 * never respondent payloads, never secrets. Consumers fetch full resources
 * through the API using the event's identifiers (at-least-once + event id).
 */

export const WEBHOOK_SCHEMA_V = 1;

export interface DeliveryJob {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_type: string;
  attempts: number;
  outbox_event_id: string;
  url: string;
  secret_enc: string;
  form_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export interface WebhookEnvelope {
  event: {
    id: string;
    type: string;
    schema_v: number;
    occurred_at: string;
    workspace_id: string;
  };
  resource: {
    type: string;
    id: string;
    form_id: string | null;
  };
  data: Record<string, unknown>;
}

const KNOWN_EVENTS = new Set(["submission.created", "submission.status_changed"]);

/**
 * Build the signed envelope for one claimed delivery. Unknown event types
 * are refused (return null → caller marks the delivery failed/permanent).
 */
export function buildWebhookEnvelope(job: DeliveryJob): WebhookEnvelope | null {
  if (!KNOWN_EVENTS.has(job.event_type)) return null;
  const payload = job.payload ?? {};
  const data: Record<string, unknown> = {
    submission_id: payload["submission_id"] ?? null,
    form_id: typeof payload["form_id"] === "string" ? payload["form_id"] : job.form_id,
  };
  if (job.event_type === "submission.status_changed") {
    if (typeof payload["from"] === "string") data["from"] = payload["from"];
    if (typeof payload["to"] === "string") data["to"] = payload["to"];
  } else {
    if (typeof payload["status"] === "string") data["status"] = payload["status"];
    if (typeof payload["published_version_no"] === "number") data["published_version_no"] = payload["published_version_no"];
  }
  return {
    event: {
      id: job.outbox_event_id,
      type: job.event_type,
      schema_v: WEBHOOK_SCHEMA_V,
      occurred_at: job.occurred_at,
      workspace_id: job.workspace_id,
    },
    resource: {
      type: "submission",
      id: typeof payload["submission_id"] === "string" ? (payload["submission_id"] as string) : job.outbox_event_id,
      form_id: typeof data["form_id"] === "string" ? (data["form_id"] as string) : null,
    },
    data,
  };
}
