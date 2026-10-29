"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { parseCanonicalForm, type CanonicalForm } from "@formos/forms-engine";
import { FormosForm } from "@formos/renderer";
import { fileFieldKeys, makeSubmissionGate } from "@/lib/public/submissionGate";
import { copyFor } from "@/lib/public/intakeErrors";

type RendererSchema = ComponentProps<typeof FormosForm>["schema"];
type RendererUiSchema = ComponentProps<typeof FormosForm>["uiSchema"];

/**
 * Respondent submit flow (Phase 6 public UX).
 * Client Zod gate (same generator as the server) → POST to the BFF intake
 * route → receipt-only response. States: idle / submitting / success / error,
 * with accessible announcements + focus management and a honeypot decoy.
 */

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; submissionId: string }
  | { kind: "error"; message: string; fieldErrors: Array<{ key: string; message: string }> };

export function PublicFormClient({
  publicId,
  snapshot,
  jsonSchema,
  uiSchema,
  captchaRequired,
}: {
  publicId: string;
  snapshot: CanonicalForm;
  jsonSchema: RendererSchema;
  uiSchema: RendererUiSchema;
  captchaRequired: boolean;
}): React.ReactElement {
  const [state, setState] = useState<SubmitState>({ kind: "idle" });
  // One idempotency key per submit intent: stable across retries of the same
  // attempt, regenerated after success so "submit another" never dedupes.
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const honeypotRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);

  const gate = useMemo(() => {
    try {
      return makeSubmissionGate(parseCanonicalForm(snapshot));
    } catch {
      return null;
    }
  }, [snapshot]);

  const blockedFileKeys = useMemo(() => {
    try {
      return fileFieldKeys(parseCanonicalForm(snapshot));
    } catch {
      return [];
    }
  }, [snapshot]);

  useEffect(() => {
    // Move focus to the status region on terminal states (screen readers).
    if (state.kind === "success" || state.kind === "error") {
      statusRef.current?.focus();
    }
  }, [state]);

  if (gate === null) {
    return (
      <div role="alert">
        <p>This form is currently unavailable. Please try again later.</p>
      </div>
    );
  }

  async function handleValidSubmit(values: Record<string, unknown>): Promise<void> {
    if (submitting.current) return;
    submitting.current = true;
    setState({ kind: "submitting" });
    try {
      const res = await fetch(`/api/public/forms/${encodeURIComponent(publicId)}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values,
          idempotencyKey: idempotencyKey.current,
          website: honeypotRef.current?.value ?? "",
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        submissionId?: string;
        code?: string;
        errors?: Array<{ key: string; message: string }>;
      } | null;
      if (res.ok && body?.success === true && typeof body.submissionId === "string") {
        idempotencyKey.current = crypto.randomUUID();
        setState({ kind: "success", submissionId: body.submissionId });
      } else {
        const code = typeof body?.code === "string" ? body.code : "SUBMISSION_FAILED";
        setState({
          kind: "error",
          message: copyFor(code),
          fieldErrors: Array.isArray(body?.errors) ? body.errors : [],
        });
      }
    } catch {
      setState({ kind: "error", message: copyFor("SUBMISSION_FAILED"), fieldErrors: [] });
    } finally {
      submitting.current = false;
    }
  }

  if (state.kind === "success") {
    return (
      <div ref={statusRef} tabIndex={-1} role="status" aria-live="polite">
        <h2>Thank you — your response was received.</h2>
        <p className="muted">Reference: {state.submissionId.slice(0, 8)}…</p>
        <button
          type="button"
          className="secondary"
          onClick={() => setState({ kind: "idle" })}
        >
          Submit another response
        </button>
      </div>
    );
  }

  return (
    <div>
      {blockedFileKeys.length > 0 ? (
        <p className="muted" role="note">
          Note: file uploads are not yet enabled for this form — questions asking for files cannot be completed yet.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <div ref={statusRef} tabIndex={-1} role="alert" className="error">
          <p>{state.message}</p>
          {state.fieldErrors.length > 0 ? (
            <ul>
              {state.fieldErrors.map((e, i) => (
                <li key={`${e.key}-${i}`}>
                  {e.key}: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {state.kind === "submitting" ? (
        <div role="status" aria-live="polite" aria-busy="true">
          <p>Submitting…</p>
        </div>
      ) : null}
      <div aria-hidden="true" className="hp-wrap">
        {/* Honeypot decoy: invisible to humans, irresistible to naive bots. */}
        <label>
          Website
          <input ref={honeypotRef} type="text" name="website" autoComplete="off" tabIndex={-1} />
        </label>
      </div>
      <div aria-busy={state.kind === "submitting"} className={state.kind === "submitting" ? "is-submitting" : undefined}>
        <FormosForm
          schema={jsonSchema}
          {...(uiSchema === undefined ? {} : { uiSchema })}
          validate={gate}
          onValidSubmit={handleValidSubmit}
          onInvalidSubmit={() => {
            setState({ kind: "error", message: copyFor("INVALID_SUBMISSION"), fieldErrors: [] });
          }}
        />
      </div>
      {captchaRequired ? (
        <p className="muted">
          <small>This form is protected by bot checks.</small>
        </p>
      ) : null}
    </div>
  );
}
