/**
 * FORMOS stub validator — the mechanism that keeps RJSF from becoming the
 * validation authority (ADR-003 §2).
 *
 * RJSF requires a `validator` prop, but with `noValidate` set the form never
 * asks it to judge data. Every method is a total no-op reporting "valid":
 * - `validateFormData` → empty error schema (customValidate still honored by
 *   RJSF internals if ever passed; we never pass one)
 * - `isValid` → true (used for schema-condition resolution; our derived
 *   schemas contain no conditionals, so this path is inert)
 * - `rawValidation` → no errors
 *
 * Actual authority is the generated Zod schema, executed in `FormosForm`'s
 * submit gate (client) and re-derived server-side (pre-RPC). No AJV is
 * imported anywhere in this package — asserted by tests + architecture guards.
 */
import type { ValidatorType } from "@rjsf/utils";

export const formosValidator: ValidatorType = {
  validateFormData() {
    return { errors: [], errorSchema: {} };
  },
  isValid() {
    return true;
  },
  rawValidation() {
    return {};
  },
};
