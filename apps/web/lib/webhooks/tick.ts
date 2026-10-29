import { decryptWebhookSecret } from "@formos/database";
import { buildWebhookEnvelope, type DeliveryJob } from "./envelope";
import { ATTEMPT_TIMEOUT_MS, classifyOutcome, MAX_RESPONSE_BYTES } from "./retry";
import { signWebhook } from "./signing";
import { assertUrlSafe, type DnsResolver } from "./ssrf";

/**
 * Scheduled outbox tick (Phase 9, Stage 0 pump).
 * Pull-based, bounded, no persistent worker: claim fan-out batch → expand
 * deliveries → claim due deliveries → HTTP POST each → record outcome.
 * Single-flight is enforced DB-side (transaction-scoped advisory lock inside
 * tick_fanout/claim_deliveries); SKIP LOCKED + UNIQUE(endpoint,event)
 * idempotency make concurrent ticks safe regardless.
 *
 * All DB access goes through the injected Db (service-role client in prod).
 * HTTP is injected for deterministic unit tests.
 */

export interface TickDb {
  fanout(limit: number): Promise<{ claimed: number; expanded: number; skipped: number; failed: number }>;
  claimDeliveries(limit: number): Promise<DeliveryJob[]>;
  recordDelivery(input: {
    deliveryId: string;
    ok: boolean;
    permanent: boolean;
    statusCode: number | null;
    error: string | null;
    responseMs: number;
  }): Promise<{ recorded: boolean; status?: string | undefined; disabled?: boolean | undefined }>;
}

export interface HttpPost {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{
    status: number | null;
    redirected: boolean;
    error?: string | undefined;
  }>;
}

export interface TickSummary {
  ran: boolean;
  fanout: { claimed: number; expanded: number; skipped: number; failed: number } | null;
  attempted: number;
  delivered: number;
  retryable: number;
  permanent: number;
  dead: number;
  disabledEndpoints: string[];
  error?: string;
}

export const TICK_FANOUT_LIMIT = 100;
export const TICK_DELIVERY_LIMIT = 25;
/** Hard wall-clock cap per tick (Vercel/serverless friendly). */
export const TICK_BUDGET_MS = 50_000;

export function defaultHttpPost(maxBytes: number = MAX_RESPONSE_BYTES): HttpPost {
  return async (url, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.any([init.signal, controller.signal]),
      });
      // Drain (bounded) so connections can be reused; body content is discarded.
      try {
        const reader = res.body?.getReader();
        if (reader) {
          let received = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) break;
          }
          try { await reader.cancel(); } catch { /* ignored */ }
        }
      } catch { /* body drain is best-effort */ }
      const location = res.headers.get("location");
      return {
        status: res.status,
        redirected: res.status >= 300 && res.status < 400 && location !== null,
        error: undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      return { status: null, redirected: false, error: message.slice(0, 200) };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export interface TickOptions {
  fanoutLimit?: number;
  deliveryLimit?: number;
  budgetMs?: number;
  now?: () => number;
  /** Injectable DNS resolver (tests use a stub; production uses real DNS). */
  dnsResolve?: DnsResolver | undefined;
}

/**
 * Run one bounded tick. Returns a summary (never throws for per-delivery
 * failures; throws only on fatal fan-out/claim errors after recording what
 * it can).
 */
export async function runOutboxTick(
  db: TickDb,
  httpPost: HttpPost,
  opts: TickOptions = {},
): Promise<TickSummary> {
  const startedAt = Date.now();
  const summary: TickSummary = {
    ran: true,
    fanout: null,
    attempted: 0,
    delivered: 0,
    retryable: 0,
    permanent: 0,
    dead: 0,
    disabledEndpoints: [],
  };
  const overBudget = () => Date.now() - startedAt > (opts.budgetMs ?? TICK_BUDGET_MS);

  const fanout = await db.fanout(opts.fanoutLimit ?? TICK_FANOUT_LIMIT);
  summary.fanout = fanout;

  const claimed = await db.claimDeliveries(opts.deliveryLimit ?? TICK_DELIVERY_LIMIT);
  for (const job of claimed) {
    if (overBudget()) break;
    summary.attempted += 1;
    const outcome = await deliverOne(job, httpPost, { now: opts.now ?? Date.now, resolveDns: opts.dnsResolve });
    const recorded = await db.recordDelivery({
      deliveryId: job.id,
      ok: outcome.kind === "delivered",
      permanent: outcome.kind === "permanent",
      statusCode: outcome.statusCode,
      error: outcome.kind === "delivered" ? null : outcome.error,
      responseMs: outcome.responseMs,
    });
    if (outcome.kind === "delivered") summary.delivered += 1;
    else if (outcome.kind === "retryable") summary.retryable += 1;
    else summary.permanent += 1;
    if (recorded.status === "dead") summary.dead += 1;
    if (recorded.disabled) summary.disabledEndpoints.push(job.endpoint_id);
  }
  return summary;
}

export type DeliveryOutcome =
  | { kind: "delivered"; statusCode: number; responseMs: number }
  | { kind: "retryable"; statusCode: number | null; error: string; responseMs: number }
  | { kind: "permanent"; statusCode: number | null; error: string; responseMs: number };

async function deliverOne(job: DeliveryJob, httpPost: HttpPost, opts: { now: () => number; resolveDns?: DnsResolver | undefined }): Promise<DeliveryOutcome> {
  const now = opts.now;
  const started = Date.now();
  const finish = (outcome:
    | { kind: "delivered"; statusCode: number }
    | { kind: "retryable"; statusCode: number | null; error: string }
    | { kind: "permanent"; statusCode: number | null; error: string }
  ): DeliveryOutcome => ({
    ...outcome,
    responseMs: Date.now() - started,
  } as DeliveryOutcome);
  // 1. Build envelope (unknown types are refused → permanent, no HTTP).
  const envelope = buildWebhookEnvelope(job);
  if (!envelope) {
    return finish({ kind: "permanent", statusCode: null, error: "unknown event type" });
  }
  // 2. SSRF gate (DNS-resolved, redirects never followed downstream).
  const safe = opts.resolveDns === undefined ? await assertUrlSafe(job.url) : await assertUrlSafe(job.url, opts.resolveDns);
  if (!safe.ok) {
    return finish({ kind: "permanent", statusCode: null, error: `unsafe destination: ${safe.reason}` });
  }
  // 3. Decrypt signing secret (never logged, never returned).
  let secret: string;
  try {
    secret = await decryptWebhookSecret(job.secret_enc);
  } catch {
    return finish({ kind: "permanent", statusCode: null, error: "secret unavailable" });
  }
  const rawBody = JSON.stringify(envelope);
  const timestamp = Math.floor(now() / 1000);
  const signed = signWebhook(secret, timestamp, rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await httpPost(safe.url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-formos-event": envelope.event.type,
        "x-formos-delivery": job.id,
        "x-formos-timestamp": String(timestamp),
        "x-formos-signature": signed.header,
        "user-agent": "FORMOS-Webhooks/1.0",
      },
      body: rawBody,
      signal: controller.signal,
    });
    return finish(
      classifyOutcome({
        ok: res.status !== null && res.status >= 200 && res.status < 300,
        status: res.status,
        error: res.error,
        responseMs: 0,
        redirected: res.redirected,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return finish({ kind: "retryable", statusCode: null, error: message.slice(0, 200) });
  } finally {
    clearTimeout(timeout);
  }
}
