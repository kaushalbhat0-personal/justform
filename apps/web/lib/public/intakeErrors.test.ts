import { describe, expect, it } from "vitest";
import {
  copyFor,
  errorBody,
  mapAvailabilityReason,
  mapIntakeRpcError,
  PUBLIC_ERROR_CODES,
} from "./intakeErrors";

describe("public error contract", () => {
  it("covers the full respondent code set with safe copy", () => {
    expect(PUBLIC_ERROR_CODES).toEqual([
      "FORM_NOT_AVAILABLE",
      "FORM_NOT_YET_OPEN",
      "FORM_CLOSED",
      "FORM_LIMIT_REACHED",
      "INVALID_SUBMISSION",
      "SUBMISSION_RATE_LIMITED",
      "SUBMISSION_DUPLICATE",
      "SUBMISSION_FAILED",
    ]);
    for (const code of PUBLIC_ERROR_CODES) {
      const body = errorBody(code);
      expect(body.success).toBe(false);
      expect(body.code).toBe(code);
      expect(body.message.length).toBeGreaterThan(0);
      // No identifiers, no internals in respondent copy.
      expect(JSON.stringify(body)).not.toMatch(/workspace|uuid|SQL|PGRST|stack/i);
    }
  });

  it("copyFor is total (unknown codes fall back safely)", () => {
    expect(copyFor("FORM_CLOSED")).toContain("no longer");
    expect(copyFor("SOMETHING_ELSE")).toBe(copyFor("SUBMISSION_FAILED"));
  });

  it("maps the intake RPC vocabulary to codes + statuses", () => {
    expect(mapIntakeRpcError("not available")).toEqual({ status: 404, code: "FORM_NOT_AVAILABLE" });
    expect(mapIntakeRpcError("ERROR: not open")).toEqual({ status: 403, code: "FORM_NOT_YET_OPEN" });
    expect(mapIntakeRpcError("limit reached")).toEqual({ status: 409, code: "FORM_LIMIT_REACHED" });
    expect(mapIntakeRpcError("duplicate")).toEqual({ status: 409, code: "SUBMISSION_DUPLICATE" });
    expect(mapIntakeRpcError("invalid payload")).toEqual({ status: 422, code: "INVALID_SUBMISSION" });
    expect(mapIntakeRpcError("payload too large")).toEqual({ status: 422, code: "INVALID_SUBMISSION" });
    expect(mapIntakeRpcError("attachments not available")).toEqual({ status: 422, code: "INVALID_SUBMISSION" });
    expect(mapIntakeRpcError("closed")).toEqual({ status: 410, code: "FORM_CLOSED" });
    // Unknown internals collapse to a generic 500.
    expect(mapIntakeRpcError("column \"x\" does not exist")).toEqual({ status: 500, code: "SUBMISSION_FAILED" });
    expect(mapIntakeRpcError(undefined)).toEqual({ status: 500, code: "SUBMISSION_FAILED" });
  });

  it("maps availability reasons without leaking internals", () => {
    expect(mapAvailabilityReason("not_open")).toEqual({ status: 403, code: "FORM_NOT_YET_OPEN" });
    expect(mapAvailabilityReason("capped")).toEqual({ status: 409, code: "FORM_LIMIT_REACHED" });
    expect(mapAvailabilityReason("closed")).toEqual({ status: 410, code: "FORM_CLOSED" });
    expect(mapAvailabilityReason("anything-else")).toEqual({ status: 410, code: "FORM_CLOSED" });
  });
});
