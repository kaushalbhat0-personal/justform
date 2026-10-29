import { NextResponse } from "next/server";
import { DomainError } from "@formos/domain";
import type { RateLimitResult } from "@/lib/public/rateLimit";

/**
 * Versioned public API envelope (Phase 9, /api/v1/*).
 * Success: { data, page? }. Errors: { error: { code, message, request_id } }
 * with a stable machine-readable code — never SQL/RLS internals.
 */

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "INVALID_CURSOR"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "INTERNAL";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number | undefined;
  constructor(code: ApiErrorCode, message: string, status: number, retryAfterSeconds?: number | undefined) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ApiPage {
  next_cursor: string | null;
  has_more: boolean;
}

export function apiOk(
  requestId: string,
  data: unknown,
  init?: { page?: ApiPage; rateLimit?: RateLimitResult; limit?: number },
): NextResponse {
  const body: Record<string, unknown> = { data };
  if (init?.page) body["page"] = init.page;
  const res = NextResponse.json(body, { status: 200 });
  return withRateLimitHeaders(withRequestId(res, requestId), init);
}

export function apiErrorResponse(err: unknown, requestId: string, fallbackMessage = "Internal error."): NextResponse {
  if (err instanceof ApiError) {
    const res = NextResponse.json(
      { error: { code: err.code, message: err.message, request_id: requestId } },
      { status: err.status },
    );
    if (err.retryAfterSeconds !== undefined) res.headers.set("Retry-After", String(err.retryAfterSeconds));
    return withRateLimitHeaders(withRequestId(res, requestId), { retryAfter: err.retryAfterSeconds, rateLimited: err.code === "RATE_LIMITED" });
  }
  // Shared query helpers throw DomainError (cursor/shape failures) — map to
  // the stable API contract instead of leaking a 500.
  if (err instanceof DomainError) {
    const mapped: Record<string, { code: ApiErrorCode; status: number }> = {
      not_found: { code: "NOT_FOUND", status: 404 },
      forbidden: { code: "FORBIDDEN", status: 403 },
      unauthorized: { code: "UNAUTHENTICATED", status: 401 },
      validation_failed: { code: "VALIDATION_FAILED", status: 400 },
      rate_limited: { code: "RATE_LIMITED", status: 429 },
    };
    const m = mapped[err.code];
    if (m) {
      const res = NextResponse.json(
        { error: { code: m.code, message: err.message, request_id: requestId } },
        { status: m.status },
      );
      return withRequestId(res, requestId);
    }
  }
  return withRequestId(
    NextResponse.json({ error: { code: "INTERNAL", message: fallbackMessage, request_id: requestId } }, { status: 500 }),
    requestId,
  );
}

function withRequestId(res: NextResponse, requestId: string): NextResponse {
  res.headers.set("x-request-id", requestId);
  return res;
}

function withRateLimitHeaders(
  res: NextResponse,
  init?: { page?: ApiPage; rateLimit?: RateLimitResult; limit?: number; retryAfter?: number | undefined; rateLimited?: boolean },
): NextResponse {
  if (init?.limit !== undefined) res.headers.set("X-RateLimit-Limit", String(init.limit));
  if (init?.rateLimit && !init.rateLimit.ok) {
    res.headers.set("Retry-After", String(Math.ceil(init.rateLimit.retryAfterMs / 1000)));
  }
  if (init?.retryAfter !== undefined) res.headers.set("Retry-After", String(init.retryAfter));
  return res;
}

/** Parse a positive int query param within [min, max]; throws VALIDATION_FAILED. */
export function parseLimitParam(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("VALIDATION_FAILED", "Invalid limit: must be a positive integer.", 400);
  }
  return Math.min(n, max);
}
