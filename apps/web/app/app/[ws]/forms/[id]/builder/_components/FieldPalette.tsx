"use client";

import { FIELD_CAPABILITIES, PALETTE_ORDER, type MvpFieldType } from "@formos/builder";

/** Field palette: every entry derives from the canonical capability registry. */
export function FieldPalette({
  onAdd,
  disabled,
}: {
  onAdd: (type: MvpFieldType) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div>
      <h2>Add field</h2>
      <ul className="palette-list">
        {PALETTE_ORDER.map((type) => {
          const capability = FIELD_CAPABILITIES[type];
          return (
            <li key={type}>
              <button
                type="button"
                className="secondary palette-item"
                onClick={() => onAdd(type)}
                disabled={disabled}
                aria-label={`Add ${capability.label} field`}
                title={capability.description}
              >
                <span aria-hidden="true" className="palette-glyph">
                  {capability.label.charAt(0)}
                </span>
                {capability.label}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="muted">New fields land after the selected field.</p>
    </div>
  );
}
