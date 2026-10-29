import { describe, expect, it } from "vitest";
import { buildWebhookEnvelope, WEBHOOK_SCHEMA_V, type DeliveryJob } from "./envelope";

const baseJob: DeliveryJob = {
  id: "del-1",
  endpoint_id: "ep-1",
  workspace_id: "ws-1",
  event_type: "submission.created",
  attempts: 0,
  outbox_event_id: "evt-1",
  url: "https://hooks.example.com/hook",
  secret_enc: "enc",
  form_id: "form-1",
  payload: {},
  occurred_at: "2026-01-01T00:00:00.000Z",
};

describe("webhook envelope", () => {
  it("builds a minimal created event (receipt metadata only)", () => {
    const env = buildWebhookEnvelope({
      ...baseJob,
      payload: { submission_id: "sub-1", form_id: "form-1", status: "new", published_version_no: 3 },
    });
    expect(env).toMatchObject({
      event: { id: "evt-1", type: "submission.created", schema_v: WEBHOOK_SCHEMA_V, workspace_id: "ws-1" },
      resource: { type: "submission", id: "sub-1", form_id: "form-1" },
      data: { submission_id: "sub-1", status: "new", published_version_no: 3 },
    });
    expect(JSON.stringify(env)).not.toContain("answer");
  });

  it("carries from/to on status changes and nothing else sensitive", () => {
    const env = buildWebhookEnvelope({
      ...baseJob,
      event_type: "submission.status_changed",
      payload: { submission_id: "sub-1", form_id: "form-1", from: "new", to: "read" },
    });
    expect(env?.data).toEqual({ submission_id: "sub-1", form_id: "form-1", from: "new", to: "read" });
  });

  it("rejects unknown event types", () => {
    expect(buildWebhookEnvelope({ ...baseJob, event_type: "billing.plan_changed" })).toBeNull();
  });

  it("falls back safely when payload fields are missing", () => {
    const env = buildWebhookEnvelope({ ...baseJob, payload: {} });
    expect(env?.data.submission_id).toBeNull();
    expect(env?.resource.id).toBe("evt-1");
  });
});
