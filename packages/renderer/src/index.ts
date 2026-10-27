/**
 * @formos/renderer — RJSF is wrapped here and ONLY here (ADR-003).
 *
 * No other package or app may import `@rjsf/*` directly: the renderer stays
 * replaceable (fallback: JSON Forms) with the canonical schema untouched.
 * This package owns the stub validator, the Zod-gated form shell, and the
 * widget registry used by derived uiSchemas.
 */
export { FormosForm, formosValidator, type SubmissionGate, type FormosFormProps } from "./FormosForm.js";
export { FormosFileRefWidget } from "./widgets.js";
