import postgres, { type Sql } from "postgres";

/**
 * Least-privilege intake connection (Phase 6 — frozen ARCH-FIX-002 boundary).
 * The BFF calls `formos.submit_submission` as the `intake_caller` role:
 * EXECUTE-only, zero table grants, never the service role. Credentials come
 * from server-only env (DATABASE_URL / INTAKE_DATABASE_URL + the
 * intake_caller password) — this module is imported exclusively by server
 * request handlers, never by client components.
 *
 * Lives in @formos/database (not apps/web/lib) so the G4 browser-tree
 * secret scan stays airtight: no secret names appear under apps/.
 */
export class IntakeUnavailableError extends Error {
  constructor(message = "Submission intake is unavailable.") {
    super(message);
    this.name = "IntakeUnavailableError";
  }
}

/**
 * Connection URL for the intake path. INTAKE_DATABASE_URL (a complete,
 * operator-configured URL for the intake_caller role, e.g. through the
 * Supavisor pooler as `intake_caller.<ref>`) wins; otherwise DATABASE_URL
 * is reused with only the credentials swapped to intake_caller.
 */
function intakeConnectionUrl(): string {
  const override = process.env.INTAKE_DATABASE_URL;
  if (override) return override;
  const password = process.env.INTAKE_DB_ROLE_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;
  if (!password || !databaseUrl) throw new IntakeUnavailableError();
  const url = new URL(databaseUrl);
  url.username = "intake_caller";
  url.password = password;
  return url.toString();
}

let cached: Sql | null = null;

/** Singleton intake_caller client (small pool — serverless-safe). */
export function getIntakeSql(): Sql {
  if (cached) return cached;
  const connectionUrl = intakeConnectionUrl();
  const url = new URL(connectionUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  cached = postgres(connectionUrl, {
    max: 3,
    idle_timeout: 10,
    connect_timeout: 10,
    // prepare:false keeps the Supabase pooler (transaction mode) happy.
    prepare: false,
    ...(local ? {} : { ssl: "require" as const }),
  });
  return cached;
}

export interface IntakeReceipt {
  submission_id: string;
  duplicate: boolean;
  status: string;
}

/** Invoke the intake RPC; throws IntakeUnavailableError or the RPC error. */
export async function callSubmitSubmission(input: {
  publicId: string;
  submissionId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<IntakeReceipt> {
  const sql = getIntakeSql();
  // NOTE: the payload object is interpolated directly — postgres.js
  // serializes objects to JSON itself. Interpolating a pre-stringified
  // value would double-encode it into a JSON string scalar (the RPC's
  // jsonb_typeof floor then rightly rejects it as 'invalid payload').
  type JsonParam = Parameters<Sql["json"]>[0];
  const rows = await sql<{ receipt: IntakeReceipt }[]>`
    SELECT formos.submit_submission(
      ${input.publicId},
      ${input.submissionId}::uuid,
      ${sql.json(input.payload as JsonParam)},
      ${input.idempotencyKey}
    ) AS receipt
  `;
  const receipt = rows[0]?.receipt;
  if (!receipt || typeof receipt.submission_id !== "string") {
    throw new Error("intake returned no receipt");
  }
  return receipt;
}

/** Test seam: drop the cached client. */
export function resetIntakeClient(): void {
  cached = null;
}
