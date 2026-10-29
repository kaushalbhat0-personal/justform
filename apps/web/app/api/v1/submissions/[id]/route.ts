import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient, uuidv7 } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";
import { apiErrorResponse, apiOk } from "@/lib/api/envelope";
import { apiGetSubmission } from "@/lib/api/repository";

/** GET /api/v1/submissions/:id — single submission with pinned version + fields. */
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
    const { principal, rateLimit } = await authenticateApiKey({ headers: req.headers, ip: clientIp(req) });
    requireScope(principal, "submissions:read");
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const row = await apiGetSubmission(svc, principal.workspaceId, id);
    await countApiRequest(svc, principal.workspaceId, requestId);
    return apiOk(requestId, row, { rateLimit });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
