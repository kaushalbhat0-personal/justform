import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient, uuidv7 } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { apiErrorResponse, apiOk, ApiError } from "@/lib/api/envelope";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";

/** GET /api/v1/billing/usage — current plan, period, meters, limits (billing:read). */
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
    const { principal, rateLimit } = await authenticateApiKey({ headers: req.headers, ip: clientIp(req) });
    requireScope(principal, "billing:read");
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const { data, error } = await svc.rpc("get_usage_summary", { p_workspace_id: principal.workspaceId });
    if (error || !data) {
      throw new ApiError("INTERNAL", "Could not load billing usage.", 500);
    }
    await countApiRequest(svc, principal.workspaceId, requestId);
    return apiOk(requestId, data, { rateLimit });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
