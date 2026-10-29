import { NextResponse, type NextRequest } from "next/server";
import { getServiceClient, uuidv7 } from "@formos/database";
import { authenticateApiKey, requireScope } from "@/lib/api/auth";
import { countApiRequest, enforceApiQuota } from "@/lib/api/metering";
import { apiErrorResponse, apiOk } from "@/lib/api/envelope";
import { apiGetForm } from "@/lib/api/repository";

/** GET /api/v1/forms/:id — form metadata + current published version. */
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
    requireScope(principal, "forms:read");
    const svc = getServiceClient();
    await enforceApiQuota(svc, principal.workspaceId);
    const form = await apiGetForm(svc, principal.workspaceId, id);
    await countApiRequest(svc, principal.workspaceId, requestId);
    return apiOk(requestId, form, { rateLimit });
  } catch (error) {
    return apiErrorResponse(error, requestId);
  }
}
