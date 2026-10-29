import { NextResponse, type NextRequest } from "next/server";
import { callSubmitSubmission, IntakeUnavailableError, uuidv7 } from "@formos/database";
import { parseCanonicalForm, validateSubmission } from "@formos/forms-engine";
import { verifyCaptcha } from "@/lib/public/captcha";
import {
  errorBody,
  mapAvailabilityReason,
  mapIntakeRpcError,
  type FieldError,
} from "@/lib/public/intakeErrors";
import { checkRateLimit, PUBLIC_SUBMIT_LIMIT } from "@/lib/public/rateLimit";
import { resolvePublicForm } from "@/lib/public/resolvePublicForm";
import { fileFieldKeys } from "@/lib/public/submissionGate";

/**
 * Public submission intake (Phase 6 — Layer 1 of the frozen two-layer path).
 * Browser → this BFF → generated Zod (pinned snapshot) → intake_caller RPC.
 * Never trusts workspace/form/version ids from the caller: the publicId
 * resolves the entire authority chain server-side.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 300 * 1024;
const MAX_VALUES_BYTES = 256 * 1024;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Honeypot: a decoy field humans never fill. Filled → fake success, zero DB touch. */
const HONEYPOT_FIELD = "website";

function clientIp(req: NextRequest): string {
  // Vercel/proxy-provided; spoofable if the deployment lacks a trusted
  // proxy — hence a backstop only (authoritative limits live in the RPC).
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<NextResponse> {
  const { publicId } = await params;

  // 1. Abuse backstop (before any expensive work).
  const ip = clientIp(req);
  const limit = checkRateLimit(`${publicId}:${ip}`, PUBLIC_SUBMIT_LIMIT);
  if (!limit.ok) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    const res = NextResponse.json(errorBody("SUBMISSION_RATE_LIMITED", { retryAfterSeconds }), { status: 429 });
    res.headers.set("Retry-After", String(retryAfterSeconds));
    return res;
  }

  // 2. Request size (cheap header check first).
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    return NextResponse.json(errorBody("SUBMISSION_FAILED", { message: "Request is too large." }), { status: 413 });
  }

  // 3. Parse the envelope (values are validated later — never trusted here).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(errorBody("INVALID_SUBMISSION"), { status: 422 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json(errorBody("INVALID_SUBMISSION"), { status: 422 });
  }
  const envelope = body as Record<string, unknown>;

  // 4. Honeypot: bots self-identify; acknowledge without touching the DB.
  if (typeof envelope[HONEYPOT_FIELD] === "string" && envelope[HONEYPOT_FIELD] !== "") {
    return NextResponse.json({ success: true, submissionId: uuidv7() }, { status: 200 });
  }

  const idempotencyKey = envelope["idempotencyKey"];
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return NextResponse.json(errorBody("INVALID_SUBMISSION"), { status: 422 });
  }
  const values = envelope["values"];
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return NextResponse.json(errorBody("INVALID_SUBMISSION"), { status: 422 });
  }
  if (Buffer.byteLength(JSON.stringify(values), "utf8") > MAX_VALUES_BYTES) {
    return NextResponse.json(errorBody("SUBMISSION_FAILED", { message: "Request is too large." }), { status: 413 });
  }

  // 5. Publication lookup (server-side; uniform miss → no enumeration).
  const resolved = await resolvePublicForm(publicId);
  if (!resolved.ok) {
    return NextResponse.json(errorBody("FORM_NOT_AVAILABLE"), { status: 404 });
  }
  if (!resolved.available) {
    const mapped = mapAvailabilityReason(resolved.reason);
    return NextResponse.json(errorBody(mapped.code), { status: mapped.status });
  }

  // 6. CAPTCHA / bot verification (boundary: enforced only when configured).
  if (resolved.snapshot.settings.captcha === true) {
    const verdict = await verifyCaptcha(
      typeof envelope["turnstileToken"] === "string" ? (envelope["turnstileToken"] as string) : undefined,
      ip === "unknown" ? undefined : ip,
    );
    if (!verdict.ok) {
      return NextResponse.json(errorBody("SUBMISSION_FAILED"), { status: 422 });
    }
  }

  // 7. Server-side Zod validation from the PINNED snapshot (422 = stop, no RPC).
  let canonical;
  try {
    canonical = parseCanonicalForm(resolved.snapshot);
  } catch {
    return NextResponse.json(errorBody("FORM_NOT_AVAILABLE"), { status: 404 });
  }
  // File pipeline deferred: reject non-empty file refs with a clear error
  // (the RPC re-enforces this as the integrity floor).
  for (const key of fileFieldKeys(canonical)) {
    const value = (values as Record<string, unknown>)[key];
    if (Array.isArray(value) && value.length > 0) {
      const errors: FieldError[] = [{ key, code: "unavailable", message: "File uploads are not yet enabled for this form." }];
      return NextResponse.json(errorBody("INVALID_SUBMISSION", { errors }), { status: 422 });
    }
  }
  const gated = validateSubmission(canonical, values);
  if (!gated.ok) {
    const errors: FieldError[] = gated.errors.map((e) => ({ key: e.key, code: e.code, message: e.message }));
    return NextResponse.json(errorBody("INVALID_SUBMISSION", { errors }), { status: 422 });
  }

  // 8. Intake RPC through the least-privilege role (single transaction).
  try {
    const receipt = await callSubmitSubmission({
      publicId,
      submissionId: uuidv7(),
      payload: gated.values,
      idempotencyKey,
    });
    return NextResponse.json({ success: true, submissionId: receipt.submission_id }, { status: 200 });
  } catch (error) {
    if (error instanceof IntakeUnavailableError) {
      return NextResponse.json(errorBody("SUBMISSION_FAILED"), { status: 503 });
    }
    // PostgresError message carries the RPC's stable vocabulary; map it and
    // never forward detail. Unknown → generic 500.
    const message = error instanceof Error ? error.message : "";
    const mapped = mapIntakeRpcError(message);
    if (mapped.code === "SUBMISSION_FAILED") {
      console.error("[public-intake] unexpected intake failure:", message.slice(0, 200));
    }
    return NextResponse.json(errorBody(mapped.code), { status: mapped.status });
  }
}
