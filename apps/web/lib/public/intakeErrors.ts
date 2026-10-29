/**
 * Public respondent error contract (Phase 6).
 *
 * Safe, actionable codes for anonymous callers. Server internals (SQL errors,
 * validation implementation details, workspace/form identifiers) are NEVER
 * forwarded — the BFF maps them here. Shared by the API route (producer) and
 * the public form client (copy) — no server-only imports, safe either side.
 */

export const PUBLIC_ERROR_CODES = [
  "FORM_NOT_AVAILABLE",
  "FORM_NOT_YET_OPEN",
  "FORM_CLOSED",
  "FORM_LIMIT_REACHED",
  "INVALID_SUBMISSION",
  "SUBMISSION_RATE_LIMITED",
  "SUBMISSION_DUPLICATE",
  "SUBMISSION_FAILED",
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export interface FieldError {
  key: string;
  code: string;
  message: string;
}

export interface PublicErrorBody {
  success: false;
  code: PublicErrorCode;
  message: string;
  errors?: FieldError[];
  retryAfterSeconds?: number;
}

export interface PublicSuccessBody {
  success: true;
  submissionId: string;
}

/** Respondent-safe copy per code (no identifiers, no internals). */
const COPY: Record<PublicErrorCode, string> = {
  FORM_NOT_AVAILABLE: "This form is not available.",
  FORM_NOT_YET_OPEN: "This form is not open yet. Please check back later.",
  FORM_CLOSED: "This form is no longer accepting responses.",
  FORM_LIMIT_REACHED: "This form has reached its response limit.",
  INVALID_SUBMISSION: "Some answers need attention before you can submit.",
  SUBMISSION_RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  SUBMISSION_DUPLICATE: "This response has already been received.",
  SUBMISSION_FAILED: "Something went wrong. Please try again.",
};

export function errorBody(code: PublicErrorCode, extra?: Partial<PublicErrorBody>): PublicErrorBody {
  return { success: false, code, message: COPY[code], ...extra };
}

/** Total copy lookup: unknown codes fall back to the generic failure copy. */
export function copyFor(code: string): string {
  return COPY[code as PublicErrorCode] ?? COPY["SUBMISSION_FAILED"];
}

/**
 * Map an intake-RPC failure to a public code + HTTP status.
 * Matches the RPC's stable error vocabulary (see migration 0006); anything
 * unrecognized becomes a generic 500 with NO detail forwarded.
 */
export function mapIntakeRpcError(message: unknown): { status: number; code: PublicErrorCode } {
  const text = typeof message === "string" ? message : "";
  // Order matters: "attachments not available" contains "not available".
  if (/attachments not available/.test(text)) return { status: 422, code: "INVALID_SUBMISSION" };
  // Workspace quota blends with the existing per-form cap semantics (409):
  // respondents learn nothing about plan state.
  if (/quota_exceeded/.test(text)) return { status: 409, code: "FORM_LIMIT_REACHED" };
  if (/not available/.test(text)) return { status: 404, code: "FORM_NOT_AVAILABLE" };
  if (/not open/.test(text)) return { status: 403, code: "FORM_NOT_YET_OPEN" };
  if (/limit reached/.test(text)) return { status: 409, code: "FORM_LIMIT_REACHED" };
  if (/payload too large|invalid payload/.test(text)) return { status: 422, code: "INVALID_SUBMISSION" };
  if (/duplicate/.test(text)) return { status: 409, code: "SUBMISSION_DUPLICATE" };
  if (/closed/.test(text)) return { status: 410, code: "FORM_CLOSED" };
  return { status: 500, code: "SUBMISSION_FAILED" };
}

/** Map a resolver availability reason to a public code + HTTP status. */
export function mapAvailabilityReason(reason: string): { status: number; code: PublicErrorCode } {
  switch (reason) {
    case "not_open":
      return { status: 403, code: "FORM_NOT_YET_OPEN" };
    case "capped":
      return { status: 409, code: "FORM_LIMIT_REACHED" };
    default:
      return { status: 410, code: "FORM_CLOSED" };
  }
}
