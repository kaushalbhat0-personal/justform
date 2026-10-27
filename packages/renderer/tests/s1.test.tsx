/**
 * S1 ACCEPTANCE TEST — the core proof (FORMOS-IMPL-003 §23):
 * canonical FORMOS form → derived JSON Schema → derived uiSchema →
 * derived Zod → RJSF render → valid input accepted → invalid rejected
 * through Zod → normalized errors mapped to canonical field IDs.
 *
 * Environment: jsdom + @testing-library/react (test-only; never shipped).
 */
import Form from "@rjsf/core";
import type { RJSFSchema } from "@rjsf/utils";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contactExample,
  generateJsonSchema,
  generateUiSchema,
  generateZod,
  parseCanonicalForm,
  resolveFieldState,
  toRjsfErrorSchema,
  validateSubmission,
  type FormValidationError,
  type UiSchema,
} from "@formos/forms-engine";
import { FormosForm } from "../src/FormosForm.js";
import { formosValidator } from "../src/validator.js";
import { FormosFileRefWidget } from "../src/widgets.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repoRoot = join(root, "..", "..");

// vitest does not provide the globals that enable testing-library
// auto-cleanup, so unmount explicitly between tests.
afterEach(() => cleanup());

function setup() {
  const canonical = parseCanonicalForm(contactExample());
  const schema = generateJsonSchema(canonical) as unknown as RJSFSchema;
  const uiSchema = generateUiSchema(canonical);
  const validate = (data: unknown) => {
    const result = validateSubmission(canonical, data);
    if (result.ok) return { ok: true as const, values: result.values };
    return { ok: false as const, errors: result.errors, errorSchema: toRjsfErrorSchema(result.errors) };
  };
  return { canonical, schema, uiSchema, validate };
}

function fillValid(): void {
  // RJSF appends "*" to required labels; { exact: false } matches the stem.
  fireEvent.change(screen.getByLabelText("Full name", { exact: false }), { target: { value: "Ada Lovelace" } });
  fireEvent.change(screen.getByLabelText("Email", { exact: false, selector: "input[type=email]" }), {
    target: { value: "ada@example.test" },
  });
  // RJSF renders enum <option>s by index (value="0","1",…); the submitted
  // formData still carries the decoded canonical value ("sales").
  fireEvent.change(screen.getByLabelText("Topic", { exact: false }), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Bio", { exact: false }), { target: { value: "Pioneer" } });
  fireEvent.change(screen.getByLabelText("Age", { exact: false }), { target: { value: "36" } });
  fireEvent.change(screen.getByLabelText("Phone", { exact: false, selector: "input[type=text]" }), {
    target: { value: "+61 412 345 678" },
  });
}

describe("S1: canonical → derived → rendered", () => {
  it("defines MVP fields and derives all three artifacts", () => {
    const { canonical, schema, uiSchema } = setup();
    expect(canonical.pages[0]?.sections[0]?.fields.length).toBeGreaterThan(10);
    expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(10);
    expect(uiSchema["ui:order"].length).toBe(Object.keys(schema.properties ?? {}).length);
    expect(Object.keys(generateZod(canonical).shape).length).toBe(Object.keys(schema.properties ?? {}).length);
  });

  it("renders the derived schema through RJSF (labels, inputs, widgets)", () => {
    const { schema, uiSchema, validate } = setup();
    const { container } = render(
      <FormosForm schema={schema} uiSchema={uiSchema} validate={validate} onValidSubmit={() => {}} />,
    );
    expect(screen.getByLabelText("Full name", { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("Email", { exact: false, selector: "input[type=email]" })).toBeTruthy();
    expect(screen.getByLabelText("Topic", { exact: false })).toBeTruthy();
    expect(screen.getByLabelText("Bio", { exact: false })).toBeTruthy();
    // Custom widget registry proof: file refs render the grant-flow placeholder.
    expect(screen.getByText(/grants arrive in phase 6/i)).toBeTruthy();
    expect(container.querySelector("form")).toBeTruthy();
  });

  it("RJSF alone does not block invalid submits (Zod is the authority)", () => {
    const { schema, uiSchema } = setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <Form
        schema={schema}
        uiSchema={uiSchema}
        validator={formosValidator}
        noValidate
        onSubmit={onSubmit}
        widgets={{ formosFileRef: FormosFileRefWidget }}
      />,
    );
    // Empty required form still reaches onSubmit: the stub never judges.
    const formEl = container.querySelector("form");
    if (!formEl) throw new Error("RJSF form did not render");
    fireEvent.submit(formEl);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("accepts valid input and delivers normalized values", () => {
    const { schema, uiSchema, validate } = setup();
    const onValidSubmit = vi.fn();
    const { container } = render(
      <FormosForm schema={schema} uiSchema={uiSchema} validate={validate} onValidSubmit={onValidSubmit} />,
    );
    fillValid();
    const formEl = container.querySelector("form");
    if (!formEl) throw new Error("FormosForm did not render");
    fireEvent.submit(formEl);
    expect(onValidSubmit).toHaveBeenCalledTimes(1);
    const values = onValidSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values["phone"]).toBe("+61412345678");
    expect(values["contact_by"]).toBe("email");
    expect(values["email"]).toBe("ada@example.test");
  });

  it("rejects invalid input through Zod and surfaces mapped errors", () => {
    const { canonical, schema, uiSchema, validate } = setup();
    const onValidSubmit = vi.fn();
    const seen: FormValidationError[][] = [];
    const { container } = render(
      <FormosForm
        schema={schema}
        uiSchema={uiSchema}
        validate={validate}
        onValidSubmit={onValidSubmit}
        onInvalidSubmit={(errors) => seen.push(errors)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Email", { exact: false, selector: "input[type=email]" }), {
      target: { value: "not-an-email" },
    });
    const formEl = container.querySelector("form");
    if (!formEl) throw new Error("FormosForm did not render");
    fireEvent.submit(formEl);
    expect(onValidSubmit).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const errors = seen[0] ?? [];
    const byKey = new Map(errors.map((e) => [e.key, e]));
    expect(byKey.get("full_name")?.code).toBe("required");
    expect(byKey.get("email")?.code).toBe("email");
    // Errors resolve to canonical stable field ids (not array indices).
    const expectedId = canonical.pages[0]?.sections[0]?.fields.find((f) => f.key === "email")?.id;
    expect(byKey.get("email")?.fieldId).toBe(expectedId);
    // RJSF renders the merged error list from extraErrors.
    expect(screen.getByText("Errors")).toBeTruthy();
  });

  it("drives show/hide churn through the rules interpreter (engine decides, RJSF renders)", () => {
    const canonical = parseCanonicalForm(contactExample());
    const { validate } = setup();
    const renderVisible = (values: Record<string, unknown>) => {
      const state = resolveFieldState(canonical, values);
      const hidden = new Set([...state.entries()].filter(([, s]) => !s.visible).map(([k]) => k));
      const fullSchema = generateJsonSchema(canonical) as unknown as {
        properties: Record<string, unknown>;
        required: string[];
      };
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fullSchema.properties)) {
        if (!hidden.has(key)) properties[key] = value;
      }
      const schema = {
        ...generateJsonSchema(canonical),
        properties,
        required: fullSchema.required.filter((k) => !hidden.has(k)),
      } as unknown as RJSFSchema;
      const ui = generateUiSchema(canonical) as UiSchema & { "ui:order": string[] };
      return { schema, uiSchema: { ...ui, "ui:order": ui["ui:order"].filter((k) => !hidden.has(k)) } };
    };
    const sales = renderVisible({ topic: "sales" });
    const first = render(
      <FormosForm schema={sales.schema} uiSchema={sales.uiSchema} validate={validate} onValidSubmit={() => {}} />,
    );
    expect(screen.queryByLabelText("Company size", { exact: false })).toBeTruthy();
    first.unmount();
    const support = renderVisible({ topic: "support" });
    render(
      <FormosForm schema={support.schema} uiSchema={support.uiSchema} validate={validate} onValidSubmit={() => {}} />,
    );
    expect(screen.queryByLabelText("Company size", { exact: false })).toBeNull();
  });

  it("ships no AJV anywhere in the renderer path", () => {
    for (const pkg of ["package.json", "node_modules/@rjsf/core/package.json", "node_modules/@rjsf/utils/package.json"]) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, pkg), "utf8")) as { dependencies?: Record<string, string> };
      expect(Object.keys(manifest.dependencies ?? {}), pkg).not.toContain("ajv");
    }
    const validatorSrc = readFileSync(join(root, "src/validator.ts"), "utf8");
    expect(validatorSrc).not.toMatch(/from\s+["']ajv/i);
    expect(validatorSrc).not.toMatch(/require\(\s*["']ajv/i);
    // Structural tree-shaking guarantee: core's only AJV touchpoint is the
    // unused getTestRegistry helper in a sideEffects:false barrel.
    const core = JSON.parse(readFileSync(join(repoRoot, "node_modules/@rjsf/core/package.json"), "utf8")) as {
      sideEffects: boolean;
    };
    expect(core.sideEffects).toBe(false);
  });
});
