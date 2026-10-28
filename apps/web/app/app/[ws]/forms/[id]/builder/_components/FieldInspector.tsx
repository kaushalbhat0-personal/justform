"use client";

import { FIELD_CAPABILITIES, type ConstraintKind, type FieldPatch, type MvpFieldType } from "@formos/builder";
import type { FormField } from "@formos/forms-engine";

/**
 * Capability-driven property editor: every control derives from
 * FIELD_CAPABILITIES + the canonical field — no per-type switch duplicated
 * elsewhere. Emits FieldPatch objects; the shell applies them canonically.
 */
export function FieldInspector({
  field,
  canEdit,
  versions,
  republishBusy,
  onPatch,
  onRepublish,
}: {
  field: FormField | null;
  canEdit: boolean;
  versions: Array<{ published_version_no: number; schema_hash: string; published_at: string }>;
  republishBusy: boolean;
  onPatch: (fieldId: string, patch: FieldPatch) => void;
  onRepublish: (publishedVersion: number) => void;
}): React.ReactElement {
  if (!field) {
    return (
      <div>
        <h2>Properties</h2>
        <p className="muted">Select a field on the canvas to edit its properties.</p>
        <VersionHistory versions={versions} canEdit={canEdit} republishBusy={republishBusy} onRepublish={onRepublish} />
      </div>
    );
  }
  const capability = FIELD_CAPABILITIES[field.type as MvpFieldType];
  return (
    <div>
      <h2>Properties</h2>
      <p className="muted">
        {capability?.label ?? field.type} · key <code>{field.key}</code>
      </p>
      <label>
        Label
        <input
          defaultValue={field.label}
          key={`label-${field.id}`}
          disabled={!canEdit}
          onBlur={(e) => {
            if (e.target.value !== field.label) onPatch(field.id, { label: e.target.value });
          }}
        />
      </label>
      <label>
        Description
        <input
          defaultValue={field.description ?? ""}
          key={`desc-${field.id}`}
          disabled={!canEdit}
          onBlur={(e) => {
            if ((e.target.value || "") !== (field.description ?? "")) onPatch(field.id, { description: e.target.value || null });
          }}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          defaultChecked={field.required}
          key={`req-${field.id}`}
          disabled={!canEdit}
          onChange={(e) => onPatch(field.id, { required: e.target.checked })}
        />
        Required
      </label>
      <label className="check">
        <input
          type="checkbox"
          defaultChecked={field.hidden === true}
          key={`hid-${field.id}`}
          disabled={!canEdit}
          onChange={(e) => onPatch(field.id, { hidden: e.target.checked })}
        />
        Hidden (never rendered)
      </label>
      {capability?.supportsPlaceholder ? (
        <label>
          Placeholder
          <input
            defaultValue={field.presentation?.placeholder ?? ""}
            key={`ph-${field.id}`}
            disabled={!canEdit}
            onBlur={(e) => onPatch(field.id, { placeholder: e.target.value || null })}
          />
        </label>
      ) : null}
      {capability?.supportsDefault ? (
        <DefaultEditor field={field} canEdit={canEdit} onPatch={onPatch} />
      ) : null}
      {capability?.supportsOptions && (field.type === "dropdown" || field.type === "radio" || field.type === "checkbox") ? (
        <OptionsEditor field={field} canEdit={canEdit} onPatch={onPatch} />
      ) : null}
      <ConstraintEditor field={field} kinds={capability?.editableConstraints ?? []} canEdit={canEdit} onPatch={onPatch} />
      <VersionHistory versions={versions} canEdit={canEdit} republishBusy={republishBusy} onRepublish={onRepublish} />
    </div>
  );
}

function DefaultEditor({
  field,
  canEdit,
  onPatch,
}: {
  field: FormField;
  canEdit: boolean;
  onPatch: (fieldId: string, patch: FieldPatch) => void;
}): React.ReactElement | null {
  const current = (field.default ?? "") as string | number;
  const inputType = field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "time" ? "time" : "text";
  return (
    <label>
      Default value
      <input
        type={inputType}
        defaultValue={current}
        key={`def-${field.id}`}
        disabled={!canEdit}
        onBlur={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            if (field.default !== undefined) onPatch(field.id, { default: undefined });
            return;
          }
          const value = field.type === "number" ? Number(raw) : raw;
          if (value !== field.default) onPatch(field.id, { default: value });
        }}
      />
    </label>
  );
}

function OptionsEditor({
  field,
  canEdit,
  onPatch,
}: {
  field: FormField & { config: { options: Array<{ value: string; label: string }> } };
  canEdit: boolean;
  onPatch: (fieldId: string, patch: FieldPatch) => void;
}): React.ReactElement {
  const options = field.config.options;
  const setOption = (index: number, part: "value" | "label", text: string): void => {
    const next = options.map((o, i) => (i === index ? { ...o, [part]: text } : o));
    onPatch(field.id, { options: next });
  };
  return (
    <fieldset>
      <legend>Options</legend>
      {options.map((option, index) => (
        <div className="row" key={index}>
          <input
            aria-label={`Option ${index + 1} value`}
            defaultValue={option.value}
            key={`ov-${field.id}-${index}`}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== option.value) setOption(index, "value", e.target.value);
            }}
          />
          <input
            aria-label={`Option ${index + 1} label`}
            defaultValue={option.label}
            key={`ol-${field.id}-${index}`}
            disabled={!canEdit}
            onBlur={(e) => {
              if (e.target.value !== option.label) setOption(index, "label", e.target.value);
            }}
          />
          <button
            type="button"
            className="secondary"
            disabled={!canEdit || options.length <= 1}
            onClick={() => onPatch(field.id, { options: options.filter((_, i) => i !== index) })}
            aria-label={`Remove option ${index + 1}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={!canEdit}
        onClick={() => {
          let n = options.length + 1;
          const values = new Set(options.map((o) => o.value));
          while (values.has(`option_${n}`)) n += 1;
          onPatch(field.id, { options: [...options, { value: `option_${n}`, label: `Option ${n}` }] });
        }}
      >
        Add option
      </button>
    </fieldset>
  );
}

function ConstraintEditor({
  field,
  kinds,
  canEdit,
  onPatch,
}: {
  field: FormField;
  kinds: ConstraintKind[];
  canEdit: boolean;
  onPatch: (fieldId: string, patch: FieldPatch) => void;
}): React.ReactElement | null {
  if (kinds.length === 0) return null;
  const validation = ((field as { validation?: Record<string, unknown> }).validation ?? {}) as Record<string, unknown>;
  const set = (key: string, value: unknown): void => {
    if (key === "mime" && typeof value === "string") {
      const list = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
      onPatch(field.id, { validation: { [key]: list.length > 0 ? list : undefined } });
      return;
    }
    onPatch(field.id, { validation: { [key]: value === "" ? undefined : value } });
  };
  const num = (key: string, label: string): React.ReactElement => (
    <label key={key}>
      {label}
      <input
        type="number"
        defaultValue={validation[key] === undefined ? "" : String(validation[key])}
        key={`${key}-${field.id}`}
        disabled={!canEdit}
        onBlur={(e) => {
          const raw = e.target.value;
          set(key, raw === "" ? undefined : Number(raw));
        }}
      />
    </label>
  );
  const text = (key: string, label: string): React.ReactElement => (
    <label key={key}>
      {label}
      <input
        defaultValue={validation[key] === undefined ? "" : String(validation[key])}
        key={`${key}-${field.id}`}
        disabled={!canEdit}
        onBlur={(e) => set(key, e.target.value === "" ? undefined : e.target.value)}
      />
    </label>
  );
  const flag = (key: string, label: string): React.ReactElement => (
    <label key={key} className="check">
      <input
        type="checkbox"
        defaultChecked={validation[key] === true}
        key={`${key}-${field.id}`}
        disabled={!canEdit}
        onChange={(e) => set(key, e.target.checked ? true : undefined)}
      />
      {label}
    </label>
  );
  return (
    <fieldset>
      <legend>Constraints</legend>
      {kinds.map((kind) => {
        switch (kind) {
          case "minLength":
            return num(kind, "Min length");
          case "maxLength":
            return num(kind, "Max length");
          case "pattern":
            return text(kind, "Pattern (regex)");
          case "min":
            return field.type === "number" ? num(kind, "Min value") : text(kind, "Min (YYYY-MM-DD / HH:MM)");
          case "max":
            return field.type === "number" ? num(kind, "Max value") : text(kind, "Max (YYYY-MM-DD / HH:MM)");
          case "integer":
            return flag(kind, "Integers only");
          case "minItems":
            return num(kind, "Min items");
          case "maxItems":
            return num(kind, "Max items");
          case "notPast":
            return flag(kind, "Not in the past");
          case "notFuture":
            return flag(kind, "Not in the future");
          case "maxMB":
            return num(kind, "Max MB");
          case "mime":
            return text(kind, "MIME allowlist (comma-separated)");
          case "maxCount":
            return num(kind, "Max files");
          default:
            return null;
        }
      })}
    </fieldset>
  );
}

function VersionHistory({
  versions,
  canEdit,
  republishBusy,
  onRepublish,
}: {
  versions: Array<{ published_version_no: number; schema_hash: string; published_at: string }>;
  canEdit: boolean;
  republishBusy: boolean;
  onRepublish: (publishedVersion: number) => void;
}): React.ReactElement {
  return (
    <div>
      <h3>Published versions (immutable)</h3>
      {versions.length === 0 ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <ul>
          {versions.map((v) => (
            <li key={v.published_version_no}>
              version {v.published_version_no} · {v.schema_hash.slice(0, 12)}… ·{" "}
              {new Date(v.published_at).toLocaleString()}{" "}
              {canEdit ? (
                <button type="button" className="secondary" disabled={republishBusy} onClick={() => onRepublish(v.published_version_no)}>
                  Rollback by republish
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
