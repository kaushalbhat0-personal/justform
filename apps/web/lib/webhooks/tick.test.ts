import { beforeAll, describe, expect, it, vi } from "vitest";
import { encryptWebhookSecret } from "@formos/database";
import { runOutboxTick, type HttpPost, type TickDb } from "./tick";
import type { DeliveryJob } from "./envelope";

const TEST_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);

beforeAll(() => {
  process.env.WEBHOOK_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

async function encSecret(): Promise<string> {
  return encryptWebhookSecret("test-signing-secret-value");
}

function job(over: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    id: "del-1",
    endpoint_id: "ep-1",
    workspace_id: "ws-1",
    event_type: "submission.created",
    attempts: 0,
    outbox_event_id: "evt-1",
    url: "https://hooks.example.com/hook",
    secret_enc: "ZW5jcnlwdGVk", // valid base64 so only decryption shape matters
    form_id: "form-1",
    payload: { submission_id: "sub-1", form_id: "form-1" },
    occurred_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const stubDns = async (): Promise<string[]> => ["8.8.8.8"];

function fakeDb(jobs: DeliveryJob[] = []): TickDb & { recorded: Array<Record<string, unknown>>; fanoutCalls: number } {
  const recorded: Array<Record<string, unknown>> = [];
  let fanoutCalls = 0;
  return {
    recorded,
    get fanoutCalls() {
      return fanoutCalls;
    },
    fanout: async () => {
      fanoutCalls += 1;
      return { claimed: jobs.length, expanded: jobs.length, skipped: 0, failed: 0 };
    },
    claimDeliveries: async () => jobs.splice(0, jobs.length),
    recordDelivery: async (input) => {
      recorded.push({ ...input });
      return { recorded: true, status: input.ok ? "delivered" : input.permanent ? "failed" : "pending", disabled: false };
    },
  };
}

describe("tick orchestration", () => {
  it("delivers due jobs and records success", async () => {
    const secretEnc = await encSecret();
    const db = fakeDb([job({ secret_enc: secretEnc })]);
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const httpPost: HttpPost = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      return { status: 200, redirected: false };
    };
    const summary = await runOutboxTick(db, httpPost, { now: () => 1_700_000_000_000, dnsResolve: stubDns });
    expect(summary.delivered).toBe(1);
    expect(summary.attempted).toBe(1);
    expect(db.recorded).toHaveLength(1);
    const sent = JSON.parse(seen[0]?.body ?? "{}") as { event: { id: string } };
    expect(sent.event.id).toBe("evt-1");
    expect(seen[0]?.headers["x-formos-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("marks retryable failures for retry and permanent ones terminal", async () => {
    const secretEnc = await encSecret();
    const db = fakeDb([job({ id: "a", secret_enc: secretEnc }), job({ id: "b", secret_enc: secretEnc })]);
    let n = 0;
    const httpPost: HttpPost = async () => {
      n += 1;
      return n === 1 ? { status: 500, redirected: false } : { status: 400, redirected: false };
    };
    const summary = await runOutboxTick(db, httpPost, { dnsResolve: stubDns });
    expect(summary.retryable).toBe(1);
    expect(summary.permanent).toBe(1);
    expect(db.recorded[0]).toMatchObject({ deliveryId: "a", ok: false, permanent: false });
    expect(db.recorded[1]).toMatchObject({ deliveryId: "b", ok: false, permanent: true });
  });

  it("stops at the wall-clock budget without losing claimed work", async () => {
    const secretEnc = await encSecret();
    const jobs = [job({ id: "a", secret_enc: secretEnc }), job({ id: "b", secret_enc: secretEnc }), job({ id: "c", secret_enc: secretEnc })];
    const db = fakeDb(jobs);
    let calls = 0;
    const httpPost: HttpPost = async () => {
      calls += 1;
      return { status: 200, redirected: false };
    };
    // Budget of 0 forces a break after the first delivery is recorded.
    const summary = await runOutboxTick(db, httpPost, { budgetMs: -1, dnsResolve: stubDns });
    expect(summary.attempted).toBeLessThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("propagates endpoint disablement from record responses", async () => {
    const secretEnc = await encSecret();
    const db = fakeDb([job({ secret_enc: secretEnc })]);
    const httpPost: HttpPost = async () => ({ status: 200, redirected: false });
    db.recordDelivery = async (input) => {
      db.recorded.push({ ...input });
      return { recorded: true, status: "dead", disabled: true };
    };
    const summary = await runOutboxTick(db, httpPost, { dnsResolve: stubDns });
    expect(summary.dead).toBe(1);
    expect(summary.disabledEndpoints).toEqual(["ep-1"]);
  });

  it("treats unknown event types and unsafe URLs as permanent without HTTP", async () => {
    const db = fakeDb([
      job({ id: "u", event_type: "billing.plan_changed" }),
      job({ id: "s", url: "http://169.254.169.254/x" }),
    ]);
    const httpPost: HttpPost = vi.fn(async () => ({ status: 200, redirected: false }));
    const summary = await runOutboxTick(db, httpPost);
    expect(summary.permanent).toBe(2);
    expect(httpPost).not.toHaveBeenCalled();
    expect(db.recorded).toHaveLength(2);
  });
});
