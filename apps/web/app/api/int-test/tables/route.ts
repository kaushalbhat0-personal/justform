import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@formos/database";
import { DomainError } from "@formos/domain";
import { getPinnedSnapshots, listSubmissions } from "@/lib/submissions";
import { serverEnv } from "@/lib/env";

/**
 * Verification-only tables probe (NOT a product surface).
 * Double-gated like /api/int-test/inbox: dead in production (APP_ENV), and
 * CRON-gated elsewhere. Used by the Tables v1 live suite.
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
    const status = error.code === "forbidden" || error.code === "not_found" ? 404 : error.status;
    return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status });
  }
  return NextResponse.json({ ok: false, error: { code: "internal" } }, { status: 500 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Production hardening (§16): dead routes in production, live-verification
  // probes elsewhere.
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
      const cursor = typeof body["cursor"] === "string" ? body["cursor"] : undefined;
      const limit = typeof body["limit"] === "number" ? body["limit"] : undefined;
      const page = await listSubmissions({
        workspaceId,
        formId,
        filters: {},
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return NextResponse.json({ ok: true, page }, { status: 200 });
    }
    if (op === "snapshots") {
      const versionIds = body["versionIds"];
      if (!Array.isArray(versionIds) || versionIds.some((v) => typeof v !== "string")) {
        return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
      }
      const snapshots = await getPinnedSnapshots({ workspaceId, formId, versionIds: versionIds as string[] });
      return NextResponse.json({ ok: true, snapshots }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: { code: "bad_request" } }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
