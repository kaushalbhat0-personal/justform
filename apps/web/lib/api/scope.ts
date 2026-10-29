import type { ApiScope } from "@formos/database";
import { ApiError } from "./envelope";

/**
 * API scope gate (pure; no I/O so it stays unit-testable without the
 * server-only boundary). Throws ApiError FORBIDDEN on mismatch.
 */
export type { ApiScope };

export function requireScope(principal: { scopes: ApiScope[] }, scope: ApiScope): void {
  if (!principal.scopes.includes(scope)) {
    throw new ApiError("FORBIDDEN", `Missing required scope: ${scope}.`, 403);
  }
}
