import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";
import { apiErrorResponse, apiOk, parseLimitParam, type ApiPage } from "@/lib/api/envelope";
import { apiListForms } from "@/lib/api/repository";
import { uuidv7 } from "@formos/database";

/** GET /api/v1/forms — workspace forms visible to the key (forms:read). */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = uuidv7();
  try {
    const url = new URL(req.url);
    const { principal, rateLimit } = await authenticateApiKey({ headers: req.headers, ip: clientIp(req) });
    requireScope(principal, "forms:read");
    const limit = parseLimitParam(url.searchParams.get("limit"), 20, 100);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const { rows, nextCursor } = await apiListForms(svc, principal.workspaceId, {
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
