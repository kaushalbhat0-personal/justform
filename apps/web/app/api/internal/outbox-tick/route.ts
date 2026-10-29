import { NextResponse } from "next/server";
import {
  callClaimDeliveries,
  callRecordDelivery,
  callTickFanout,
  isCronAuthorized,
  type ClaimedDelivery,
} from "@formos/database";
import { defaultHttpPost, runOutboxTick, TICK_DELIVERY_LIMIT, TICK_FANOUT_LIMIT } from "@/lib/webhooks/tick";

/**
 * Scheduled outbox pump (Stage 0, Phase 9).
 * Invoked by the platform scheduler with a bearer scheduler secret. Single-flight
 * is enforced DB-side; every tick is bounded (caps + wall clock) and returns
 * a JSON summary. No secrets or payloads are ever logged here.
 *
 * DB access uses the dedicated tick connection (direct SQL): the pump RPCs
 * have no PostgREST surface by design, so the service-role REST client
 * cannot invoke them.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, { status: 401 });
  }
  try {
    const db = {
      fanout: async (limit: number) => {
        const receipt = await callTickFanout(limit);
        return {
          claimed: receipt.claimed ?? 0,
          expanded: receipt.expanded ?? 0,
          skipped: receipt.skipped ?? 0,
          failed: receipt.failed ?? 0,
        };
      },
      claimDeliveries: async (limit: number) => {
        const jobs = (await callClaimDeliveries(limit)) as ClaimedDelivery[];
        return jobs.map((j) => ({
          ...j,
          // postgres returns timestamptz as Date — the signed envelope needs
          // a stable ISO string, not a locale rendering.
          occurred_at: new Date(j.occurred_at).toISOString(),
          form_id: j.form_id ?? null,
        }));
      },
      recordDelivery: async (input: {
        deliveryId: string;
        ok: boolean;
        permanent: boolean;
        statusCode: number | null;
        error: string | null;
        responseMs: number;
      }) => {
        const receipt = await callRecordDelivery({
          deliveryId: input.deliveryId,
          ok: input.ok,
          permanent: input.permanent,
          statusCode: input.statusCode,
          error: input.error,
          responseMs: input.responseMs,
        });
        return { recorded: receipt.recorded === true, status: receipt.status, disabled: receipt.disabled };
      },
    };
    const summary = await runOutboxTick(db, defaultHttpPost(), {
      fanoutLimit: TICK_FANOUT_LIMIT,
      deliveryLimit: TICK_DELIVERY_LIMIT,
    });
    return NextResponse.json({ ok: true, ...summary, elapsedMs: Date.now() - startedAt }, { status: 200 });
  } catch {
    // Never leak internals: generic body, request still counted by the scheduler.
    return NextResponse.json({ ok: false, error: { code: "INTERNAL", message: "Tick failed." }, elapsedMs: Date.now() - startedAt }, { status: 500 });
  }
}
