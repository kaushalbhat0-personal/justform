"use client";

import { FIELD_CAPABILITIES, type MvpFieldType } from "@formos/builder";
import type { CanonicalForm } from "@formos/forms-engine";
import { useState } from "react";

/**
 * Builder canvas: renders the canonical document structure (page → section →
 * field) as selectable cards. Presentation-only — the canonical document in
 * state is the single source of truth.
 */
export function FormCanvas({
  doc,
  selectedId,
  editable,
  onSelect,
  onMove,
  onDelete,
}: {
  doc: CanonicalForm;
  selectedId: string | null;
  editable: boolean;
  onSelect: (fieldId: string) => void;
  onMove: (fieldId: string, direction: "up" | "down") => void;
  onDelete: (fieldId: string) => string | null;
}): React.ReactElement {
  return (
    <div>
      <h2>Canvas</h2>
      {doc.pages.map((page) => (
        <section key={page.id} aria-label={page.title ?? page.key} className="card">
          <h3>
            {page.title ?? page.key} <span className="muted">· page</span>
          </h3>
          {page.sections.map((section) => (
            <div key={section.id}>
              {section.title ? (
                <h4>
                  {section.title} <span className="muted">· section</span>
                </h4>
              ) : null}
              <ul className="canvas-list" role="listbox" aria-label={`Fields in ${section.title ?? section.key}`}>
                {section.fields.map((field, index) => (
                  <FieldCard
                    key={field.id}
                    fieldId={field.id}
                    label={field.label}
                    type={field.type as MvpFieldType}
                    required={field.required}
                    selected={field.id === selectedId}
                    editable={editable}
                    isFirst={index === 0}
                    isLast={index === section.fields.length - 1}
                    onSelect={onSelect}
                    onMove={onMove}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function FieldCard({
  fieldId,
  label,
  type,
  required,
  selected,
  editable,
  isFirst,
  isLast,
  onSelect,
  onMove,
  onDelete,
}: {
  fieldId: string;
  label: string;
  type: MvpFieldType;
  required: boolean;
  selected: boolean;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSelect: (fieldId: string) => void;
  onMove: (fieldId: string, direction: "up" | "down") => void;
  onDelete: (fieldId: string) => string | null;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [blocker, setBlocker] = useState<string | null>(null);
  const capability = FIELD_CAPABILITIES[type];

  const armDelete = (): void => {
    if (!confirming) {
      setBlocker(null);
      setConfirming(true);
      return;
    }
    const message = onDelete(fieldId);
    if (message) {
      setBlocker(message);
      setConfirming(false);
    } else {
      setConfirming(false);
    }
  };

  const onCardKey = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(fieldId);
      return;
    }
    if (!editable) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      armDelete();
    } else if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      onMove(fieldId, "up");
    } else if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      onMove(fieldId, "down");
    }
  };

  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(fieldId)}
      onKeyDown={onCardKey}
      className={selected ? "field-card selected" : "field-card"}
      aria-label={`${label}, ${capability?.label ?? type}${required ? ", required" : ""}`}
    >
      <div className="row">
        <strong>
          {label}
          {required ? " *" : ""}
        </strong>
        <span className="badge">{capability?.label ?? type}</span>
      </div>
      <div className="row field-actions" onClick={(event) => event.stopPropagation()}>
        {editable ? (
          <>
            <button type="button" className="secondary" onClick={() => onMove(fieldId, "up")} disabled={isFirst} aria-label={`Move ${label} up`}>
              ↑
            </button>
            <button type="button" className="secondary" onClick={() => onMove(fieldId, "down")} disabled={isLast} aria-label={`Move ${label} down`}>
              ↓
            </button>
            <button
              type="button"
              className="secondary"
              onClick={armDelete}
              onBlur={() => {
                if (!blocker) setConfirming(false);
              }}
              aria-label={confirming ? `Confirm delete ${label}` : `Delete ${label}`}
            >
              {confirming ? "Confirm delete?" : "Delete"}
            </button>
          </>
        ) : null}
      </div>
      {blocker ? (
        <p role="alert" className="error">
          {blocker}
        </p>
      ) : null}
    </li>
  );
}
