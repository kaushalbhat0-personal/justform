import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient, uuidv7 } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";
import { ApiError, apiErrorResponse, apiOk, parseLimitParam, type ApiPage } from "@/lib/api/envelope";
import { apiListSubmissions } from "@/lib/api/repository";
import { isSubmissionStatus } from "@/lib/submissions/types";

/** GET /api/v1/forms/:id/submissions — bounded, keyset-paginated, pinned-version reads. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const requestId = uuidv7();
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { principal, rateLimit } = await authenticateApiKey({ headers: req.headers, ip: clientIp(req) });
    requireScope(principal, "submissions:read");
    const statusRaw = url.searchParams.get("status");
    const status = statusRaw === null || statusRaw === "" ? undefined : statusRaw;
    if (status !== undefined && !isSubmissionStatus(status)) {
      throw new ApiError("VALIDATION_FAILED", "Invalid status filter.", 400);
    }
    const qRaw = url.searchParams.get("q");
    const q = qRaw === null || qRaw.trim() === "" ? undefined : qRaw.trim().slice(0, 200);
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const limit = parseLimitParam(url.searchParams.get("limit"), 20, 100);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const page = await apiListSubmissions(svc, principal.workspaceId, id, {
      ...(status !== undefined ? { status } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const apiPage: ApiPage = { next_cursor: page.nextCursor, has_more: page.nextCursor !== null };
    await countApiRequest(svc, principal.workspaceId, requestId);
    return apiOk(requestId, page.rows, { page: apiPage, limit, rateLimit });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
