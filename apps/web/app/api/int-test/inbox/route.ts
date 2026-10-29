import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@formos/database";
import { DomainError } from "@formos/domain";
import { getSubmissionDetail, listSubmissions, setSubmissionStatusAction } from "@/lib/submissions";
import { serverEnv } from "@/lib/env";

/**
 * Verification-only inbox probe (NOT a product surface).
 * Double-gated: unreachable in production (APP_ENV=production returns 404
 * before any logic) and CRON-gated elsewhere (same trust as /api/internal/*).
 * The session cookie still identifies the caller, and every op runs the real
 * product action — membership, RBAC, pinned-version semantics, and audit
 * behave exactly as in the UI. Auth failures surface as 404 (uniform
 * non-oracle), matching the product's posture.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unavailable(): NextResponse {
  return NextResponse.json({ ok: false, error: { code: "not_found" } }, { status: 404 });
}

function denied(): NextResponse {
  return NextResponse.json({ ok: false, error: { code: "UNAUTHORIZED" } }, { status: 401 });
}

function failure(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    // Uniform non-oracle: authorization denials read as 404, like the UI.
    const status = error.code === "forbidden" || error.code === "not_found" ? 404 : error.status;
    return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status });
  }
  return NextResponse.json({ ok: false, error: { code: "internal" } }, { status: 500 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Production hardening (§16): these probes exist only for live verification
  // against non-production app instances. In production they are dead routes.
  if (serverEnv().APP_ENV === "production") return unavailable();
  const raw = req.headers.get("x-verify-secret");
  if (!isCronAuthorized(raw === null ? null : `Bearer ${raw}`)) return denied();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
  }
  const op = body["op"];
  const workspaceId = body["workspaceId"];
  const formId = body["formId"];
  if (typeof workspaceId !== "string" || typeof formId !== "string") {
    return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
  }
  try {
    if (op === "list") {
      const rawFilters = (body["filters"] ?? {}) as { status?: unknown; q?: unknown; from?: unknown; to?: unknown };
      const filters: {
        status?: "new" | "read" | "archived";
        q?: string;
        from?: string;
        to?: string;
      } = {};
      if (rawFilters.status === "new" || rawFilters.status === "read" || rawFilters.status === "archived") {
        filters.status = rawFilters.status;
      } else if (rawFilters.status !== undefined) {
        return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
      }
      if (typeof rawFilters.q === "string") filters.q = rawFilters.q;
      if (typeof rawFilters.from === "string") filters.from = rawFilters.from;
      if (typeof rawFilters.to === "string") filters.to = rawFilters.to;
      const cursor = typeof body["cursor"] === "string" ? body["cursor"] : undefined;
      const limit = typeof body["limit"] === "number" ? body["limit"] : undefined;
      const page = await listSubmissions({
        workspaceId,
        formId,
        filters,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return NextResponse.json({ ok: true, page }, { status: 200 });
    }
    if (op === "get") {
      const submissionId = body["submissionId"];
      if (typeof submissionId !== "string") {
        return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
      }
      const detail = await getSubmissionDetail({ workspaceId, formId, submissionId });
      return NextResponse.json({ ok: true, detail }, { status: 200 });
    }
    if (op === "setStatus") {
      const submissionId = body["submissionId"];
      const status = body["status"];
      if (typeof submissionId !== "string" || typeof status !== "string") {
        return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
      }
      const result = await setSubmissionStatusAction({
        workspaceId,
        formId,
        submissionId,
        status: status as "new" | "read" | "archived",
      });
      return NextResponse.json({ ok: true, result }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
