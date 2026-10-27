/**
 * Spike fixture: a canonical contact/intake form exercising the MVP contract.
 * Used by the S1 acceptance test (derive → render → validate) and as living
 * documentation of the canonical shape. Not a product form.
 */
import type { CanonicalForm } from "./schema.js";

const uuid = (n: number): string => {
  const h = n.toString(16).padStart(2, "0");
  return `10000000-0000-4000-8000-0000000000${h}`;
};

export function contactExample(): CanonicalForm {
  return {
    id: uuid(1),
    key: "contact_intake",
    schemaVersion: 1,
    rendererVersion: "rjsf-6.11+drv1",
    metadata: { title: "Contact intake", description: "S1 spike fixture", localeDefault: "en" },
    settings: {},
    pages: [
      {
        id: uuid(10),
        key: "main",
        title: "Main",
        sections: [
          {
            id: uuid(11),
            key: "details",
            title: "Details",
            fields: [
              { id: uuid(20), key: "full_name", type: "short_text", label: "Full name", required: true, validation: { minLength: 2, maxLength: 80 } },
              { id: uuid(21), key: "bio", type: "long_text", label: "Bio", required: false, presentation: { placeholder: "Tell us briefly" }, validation: { maxLength: 500 } },
              { id: uuid(22), key: "email", type: "email", label: "Email", required: true },
              { id: uuid(23), key: "age", type: "number", label: "Age", required: false, validation: { min: 0, max: 130, integer: true } },
              { id: uuid(24), key: "phone", type: "phone", label: "Phone", required: false },
              { id: uuid(25), key: "topic", type: "dropdown", label: "Topic", required: true, config: { options: [{ value: "support", label: "Support" }, { value: "sales", label: "Sales" }] } },
              { id: uuid(26), key: "contact_by", type: "radio", label: "Contact by", required: false, default: "email", config: { options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } },
              { id: uuid(27), key: "interests", type: "checkbox", label: "Interests", required: false, config: { options: [{ value: "news", label: "Newsletter" }, { value: "beta", label: "Beta program" }, { value: "events", label: "Events" }] }, validation: { maxItems: 2 } },
              { id: uuid(28), key: "visit_date", type: "date", label: "Preferred visit date", required: false, validation: { notPast: true } },
              { id: uuid(29), key: "visit_time", type: "time", label: "Preferred time", required: false },
              { id: uuid(30), key: "attachments", type: "file", label: "Attachments", required: false, validation: { maxMB: 10, mime: ["application/pdf"], maxCount: 3 } },
              { id: uuid(31), key: "campaign", type: "hidden", label: "Campaign", required: false, prefill: { source: "query", path: "utm_campaign" } },
              { id: uuid(32), key: "company_size", type: "number", label: "Company size", required: false, hidden: true, validation: { min: 1, integer: true } },
              { id: uuid(33), key: "priority", type: "number", label: "Priority", required: false, hidden: true, validation: { integer: true } },
            ],
          },
        ],
      },
    ],
    rules: [
      {
        id: "show-company-size",
        when: "show",
        if: { all: [{ field: "topic", op: "eq", value: "sales" }] },
        actions: [{ target: "company_size", kind: "show" }],
      },
      {
        id: "require-visit-time",
        when: "require",
        if: { any: [{ field: "visit_date", op: "not_empty" }] },
        actions: [{ target: "visit_time", kind: "require" }],
      },
    ],
    calculations: [
      {
        id: "calc-priority",
        target: "priority",
        expression: {
          kind: "call",
          fn: "IF",
          args: [
            { kind: "binary", op: "==", left: { kind: "ref", field: "topic" }, right: { kind: "lit", value: "sales" } },
            { kind: "lit", value: 10 },
            { kind: "lit", value: 1 },
          ],
        },
        deps: ["topic"],
      },
    ],
    localization: {},
    notificationsRef: null,
    integrationsRef: null,
  };
}
