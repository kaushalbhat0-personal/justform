import postgres, { type Sql } from "postgres";

/**
 * Dedicated server-side connection for the Stage 0 outbox tick pump.
 * The tick RPCs (tick_fanout/claim_deliveries/record_delivery) are
 * service_role-only with NO public-schema wrapper (G10: zero PostgREST
 * surface), so the pump cannot go through the PostgREST client — it uses
 * this direct connection instead (the sanctioned "dedicated server-side
 * database path"). SECURITY DEFINER functions run as owner; the caller only
 * needs EXECUTE, which the connection role holds.
 *
 * Lives in @formos/database (not apps/): no secret names under apps/.
 */
export class TickUnavailableError extends Error {
  constructor(message = "Outbox tick is unavailable.") {
    super(message);
    this.name = "TickUnavailableError";
  }
}

function tickConnectionUrl(): string {
  const override = process.env.TICK_DATABASE_URL;
  if (override) return override;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new TickUnavailableError();
  return databaseUrl;
}

let cached: Sql | null = null;

/** Singleton privileged tick client (small pool — serverless-safe). */
export function getTickSql(): Sql {
  if (cached) return cached;
  const connectionUrl = tickConnectionUrl();
  const url = new URL(connectionUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  cached = postgres(connectionUrl, {
    max: 2,
    idle_timeout: 10,
    connect_timeout: 10,
    prepare: false,
    ...(local ? {} : { ssl: "require" as const }),
  });
  return cached;
}

export interface TickFanoutReceipt {
  claimed: number;
  expanded: number;
  skipped: number;
  failed: number;
}

export async function callTickFanout(pLimit: number): Promise<TickFanoutReceipt> {
  const sql = getTickSql();
  const rows = await sql<{ receipt: TickFanoutReceipt }[]>`SELECT formos.tick_fanout(${pLimit}) AS receipt`;
  return rows[0]?.receipt ?? { claimed: 0, expanded: 0, skipped: 0, failed: 0 };
}

export interface ClaimedDelivery {
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

export async function callClaimDeliveries(pLimit: number): Promise<ClaimedDelivery[]> {
  const sql = getTickSql();
  const rows = await sql<{ jobs: ClaimedDelivery[] }[]>`SELECT formos.claim_deliveries(${pLimit}) AS jobs`;
  return (rows[0]?.jobs ?? []) as ClaimedDelivery[];
}

export interface RecordDeliveryReceipt {
  recorded: boolean;
  status?: string;
  disabled?: boolean;
}

export async function callRecordDelivery(input: {
  deliveryId: string;
  ok: boolean;
  permanent: boolean;
  statusCode: number | null;
  error: string | null;
  responseMs: number;
}): Promise<RecordDeliveryReceipt> {
  const sql = getTickSql();
  const rows = await sql<{ receipt: RecordDeliveryReceipt }[]>`
    SELECT formos.record_delivery(
      ${input.deliveryId}::uuid,
      ${input.ok},
      ${input.permanent},
      ${input.statusCode},
      ${input.error},
      ${input.responseMs}
    ) AS receipt
  `;
  return rows[0]?.receipt ?? { recorded: false };
}

/** Test seam: drop the cached client. */
export function resetTickClient(): void {
  cached = null;
}
