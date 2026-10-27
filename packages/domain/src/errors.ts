/**
 * Canonical application error model.
 * Single source of truth for error semantics across API routes, server
 * actions, and workers. NEVER attach secrets, tokens, or raw PII to errors.
 */
export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "validation_failed"
  | "rate_limited"
  | "conflict"
  | "plan_limit"
  | "gone"
  | "idempotency_conflict"
  | "internal";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  validation_failed: 422,
  rate_limited: 429,
  conflict: 409,
  plan_limit: 402,
  gone: 410,
  idempotency_conflict: 422,
  internal: 500,
};

export interface DomainErrorInit {
  code: ErrorCode;
  /** Safe, user-facing message. No internals, no secrets, no PII. */
  message: string;
  /** Structured, non-sensitive details (ids, field names — never secrets). */
  details?: Record<string, string | number | boolean | null>;
  /** Correlates logs → response → audit. */
  requestId?: string;
  /** Original cause, kept server-side only (never serialized to clients). */
  cause?: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, string | number | boolean | null>;
  readonly requestId?: string;

  constructor(init: DomainErrorInit) {
    super(init.message);
    this.name = "DomainError";
    this.code = init.code;
    this.status = HTTP_STATUS[init.code];
    this.details = init.details ?? {};
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  /** Public envelope — the ONLY shape clients receive. */
  toEnvelope(): {
    error: {
      code: ErrorCode;
      message: string;
      details: Record<string, string | number | boolean | null>;
      request_id: string;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        request_id: this.requestId ?? "req_unknown",
      },
    };
  }
}

/** Classify unknown throws at API boundaries: DomainError passes through, everything else becomes internal. */
export function toDomainError(error: unknown, requestId?: string): DomainError {
  if (error instanceof DomainError) return error;
  const init: DomainErrorInit = {
    code: "internal",
    message: "Something went wrong. Please try again.",
    cause: error,
  };
  if (requestId !== undefined) init.requestId = requestId;
  return new DomainError(init);
}
