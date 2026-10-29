import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient, uuidv7 } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";
import { apiErrorResponse, apiOk, parseLimitParam, type ApiPage } from "@/lib/api/envelope";
import { apiListDeliveries } from "@/lib/api/repository";

/** GET /api/v1/webhooks/:id/deliveries — delivery metadata (no secrets, no bodies). */
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
    requireScope(principal, "webhooks:read");
    const limit = parseLimitParam(url.searchParams.get("limit"), 20, 100);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const { rows, nextCursor } = await apiListDeliveries(svc, principal.workspaceId, id, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const page: ApiPage = { next_cursor: nextCursor, has_more: nextCursor !== null };
    await countApiRequest(svc, principal.workspaceId, requestId);
    return apiOk(requestId, rows, { page, limit, rateLimit });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
