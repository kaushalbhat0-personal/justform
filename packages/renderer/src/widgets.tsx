/**
 * Minimal `formosFileRef` widget — proof of the widget-registry extension point.
 *
 * MVP file values are attachment-ID refs (never bytes). The grant/AV pipeline
 * arrives in Phase 6, so the spike widget only announces the deferred flow and
 * stays out of the submission value (formData untouched). Registered by name
 * from the derived uiSchema (`ui:widget: "formosFileRef"`).
 */
import type { WidgetProps } from "@rjsf/utils";
import type { ReactElement } from "react";

export function FormosFileRefWidget(props: WidgetProps): ReactElement {
  const { id, label, required } = props;
  return (
    <div>
      <label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </label>
      <input
        id={id}
        type="file"
        disabled
        aria-describedby={`${id}-hint`}
        aria-label={`${label} (attachment grants arrive in Phase 6)`}
      />
      <small id={`${id}-hint`}>File grants arrive in Phase 6; refs only in MVP spike.</small>
    </div>
  );
}
