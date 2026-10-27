/**
 * `FormosForm` — the owned client-gate pattern (S1 spike).
 *
 * - Renders the derived JSON Schema + uiSchema through RJSF with
 *   `formosValidator` + `noValidate`: RJSF never judges data.
 * - RJSF's `onSubmit` re-runs the generated Zod schema first. Invalid → Zod
 *   issues are mapped to `extraErrors` (with `extraErrorsBlockSubmit`, so RJSF
 *   also blocks) and displayed via `showErrorList` + field errors. Valid →
 *   normalized values (defaults applied, phone normalized) reach
 *   `onValidSubmit`.
 * - The same `validate` function shape runs server-side pre-RPC; agreement is
 *   structural (single generator), asserted by the parity test.
 */
"use client";

import Form from "@rjsf/core";
import type { ErrorSchema, RJSFSchema, UiSchema } from "@rjsf/utils";
import { useState } from "react";
import type { ReactElement } from "react";
import type { FormValidationError, RjsfErrorSchema } from "@formos/forms-engine";
import { formosValidator } from "./validator.js";
import { FormosFileRefWidget } from "./widgets.js";

export interface GateResult {
  ok: true;
  values: Record<string, unknown>;
}

export interface GateFailure {
  ok: false;
  errors: FormValidationError[];
  errorSchema: RjsfErrorSchema;
}

/** Signature the Zod gate must satisfy (client and server share it). */
export type SubmissionGate = (data: unknown) => GateResult | GateFailure;

export interface FormosFormProps {
  schema: RJSFSchema;
  uiSchema?: UiSchema;
  initialData?: Record<string, unknown>;
  validate: SubmissionGate;
  onValidSubmit: (values: Record<string, unknown>) => void;
  onInvalidSubmit?: (errors: FormValidationError[]) => void;
}

export function FormosForm({
  schema,
  uiSchema,
  initialData,
  validate,
  onValidSubmit,
  onInvalidSubmit,
}: FormosFormProps): ReactElement {
  const [extraErrors, setExtraErrors] = useState<RjsfErrorSchema | undefined>(undefined);

  // Adapter seam: the owned RjsfErrorSchema is structurally identical to
  // RJSF's ErrorSchema; the cast keeps @rjsf types out of forms-engine.
  // The prop is spread conditionally: RJSF's props type disallows explicit
  // undefined under exactOptionalPropertyTypes.
  const errorProps = (
    extraErrors === undefined ? {} : { extraErrors: extraErrors as unknown as ErrorSchema }
  ) as { extraErrors?: ErrorSchema };

  return (
    <Form
      schema={schema}
      uiSchema={uiSchema ?? {}}
      formData={initialData}
      validator={formosValidator}
      noValidate
      showErrorList="top"
      focusOnFirstError
      {...errorProps}
      extraErrorsBlockSubmit
      widgets={{ formosFileRef: FormosFileRefWidget }}
      onSubmit={(event) => {
        // RJSF's onSubmit carries its (stub-validated) formData; the Zod gate
        // re-reads it — RJSF state is transport, Zod is authority.
        const data = (event as unknown as { formData?: unknown }).formData;
        const gate = validate(data);
        if (gate.ok) {
          setExtraErrors(undefined);
          onValidSubmit(gate.values);
        } else {
          setExtraErrors(gate.errorSchema);
          onInvalidSubmit?.(gate.errors);
        }
      }}
    />
  );
}

export { formosValidator };
