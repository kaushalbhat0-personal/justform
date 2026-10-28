"use client";

import {
  AutosaveController,
  addField,
  deleteField,
  listFields,
  moveField,
  pushHistory,
  canUndo,
  canRedo,
  undoHistory,
  redoHistory,
  createHistory,
  updateField,
  validateDocument,
  type DocumentIssue,
  type FieldPatch,
  type History,
} from "@formos/builder";
import {
  generateJsonSchema,
  generateUiSchema,
  toRjsfErrorSchema,
  validateSubmission,
  type CanonicalForm,
  type MvpFieldType,
} from "@formos/forms-engine";
import { FormosForm } from "@formos/renderer";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { WorkspaceRole } from "@formos/domain";
import { getFormDetail, publishAction, republishAction, updateDraftAction } from "@/lib/forms";
import { FieldPalette } from "./FieldPalette";
import { FieldInspector } from "./FieldInspector";
import { FormCanvas } from "./FormCanvas";

type PreviewSchema = ComponentProps<typeof FormosForm>["schema"];
type PreviewUiSchema = NonNullable<ComponentProps<typeof FormosForm>["uiSchema"]>;

export interface VersionInfo {
  published_version_no: number;
  schema_hash: string;
  published_at: string;
}

type SaveUi =
  | { status: "idle" | "dirty" | "pending" | "saving" | "saved" }
  | { status: "error"; error: string }
  | { status: "conflict"; serverRevision: number };

/**
 * Builder shell: editor state (doc, selection, history, save, conflict) with
 * all persistence flowing through the existing OCC server boundary.
 * Published snapshots are only ever read here — never written.
 */
export function BuilderShell({
  workspaceId,
  formId,
  role,
  initialDoc,
  initialRevision,
  initialVersions,
  canEdit,
}: {
  workspaceId: string;
  formId: string;
  role: WorkspaceRole;
  initialDoc: unknown;
  initialRevision: number;
  initialVersions: VersionInfo[];
  canEdit: boolean;
}): React.ReactElement {
  const parsed = validateDocument(initialDoc);
  if (!parsed.ok) throw new Error(`Stored draft failed canonical validation: ${parsed.issues[0]?.message ?? "unknown"}`);

  const [doc, setDoc] = useState<CanonicalForm>(parsed.doc);
  const [history, setHistory] = useState<History<CanonicalForm>>(() => createHistory(parsed.doc));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<DocumentIssue[]>([]);
  const [saveUi, setSaveUi] = useState<SaveUi>({ status: "idle" });
  const [serverRevision, setServerRevision] = useState(initialRevision);
  const [versions, setVersions] = useState(initialVersions);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishNote, setPublishNote] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  const saveViaServer = useCallback(
    async (next: CanonicalForm, baseRevision: number) => {
      try {
        const res = await updateDraftAction({
          workspaceId,
          formId,
          expectedRevision: baseRevision,
          documentJson: JSON.stringify(next),
        });
        if (res.ok) return { ok: true as const, revision: res.revision };
        return { ok: false as const, conflict: true as const, expectedRevision: res.expectedRevision, currentRevision: res.currentRevision };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "Save failed." };
      }
    },
    [workspaceId, formId],
  );

  const controllerRef = useRef<AutosaveController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new AutosaveController({
      debounceMs: 1200,
      initialRevision,
      save: (d, r) => saveViaServer(d, r),
      events: {
        onStatus: (status, detail) => {
          if (status === "error") setSaveUi({ status, error: detail?.error ?? "Save failed." });
          else if (status === "conflict") {
            setSaveUi({ status, serverRevision: detail?.serverRevision ?? -1 });
            if (detail?.serverRevision !== undefined) setServerRevision(detail.serverRevision);
          } else setSaveUi({ status });
        },
        onSaved: (revision) => setServerRevision(revision),
      },
    });
  }
  useEffect(() => () => controllerRef.current?.dispose(), []);

  /** Apply a local canonical edit: validate → history → autosave (if valid). */
  const applyLocal = useCallback(
    (next: CanonicalForm) => {
      const validation = validateDocument(next);
      setDoc(next);
      setIssues(validation.ok ? [] : validation.issues);
      setHistory((h) => pushHistory(h, next));
      if (validation.ok) controllerRef.current?.schedule(next, controllerRef.current.getServerRevision());
    },
    [],
  );

  const handleAdd = useCallback(
    (type: MvpFieldType) => {
      if (!canEdit) return;
      const selected = selectedId ? listFields(doc).find((f) => f.id === selectedId) : undefined;
      const { doc: next, field } = addField(doc, type, selected ? { afterFieldId: selected.id } : {});
      setSelectedId(field.id);
      applyLocal(next);
    },
    [doc, selectedId, applyLocal, canEdit],
  );

  const handleMove = useCallback(
    (fieldId: string, direction: "up" | "down") => {
      if (!canEdit) return;
      const { doc: next, moved } = moveField(doc, fieldId, direction);
      if (moved) applyLocal(next);
    },
    [doc, applyLocal, canEdit],
  );

  const handleDelete = useCallback(
    (fieldId: string): string | null => {
      if (!canEdit) return "Read-only role.";
      const result = deleteField(doc, fieldId);
      if (!result.ok) {
        return `Cannot delete: referenced by ${result.blockers.map((b) => `${b.kind} ${b.id}`).join(", ")}.`;
      }
      if (selectedId === fieldId) setSelectedId(null);
      applyLocal(result.doc);
      return null;
    },
    [doc, selectedId, applyLocal, canEdit],
  );

  const handleUndo = useCallback(() => {
    if (!canEdit) return;
    setHistory((h) => {
      if (!canUndo(h)) return h;
      const next = undoHistory(h);
      setDoc(next.present);
      const validation = validateDocument(next.present);
      setIssues(validation.ok ? [] : validation.issues);
      if (validation.ok) controllerRef.current?.schedule(next.present, controllerRef.current.getServerRevision());
      return next;
    });
  }, [canEdit]);

  const handleRedo = useCallback(() => {
    if (!canEdit) return;
    setHistory((h) => {
      if (!canRedo(h)) return h;
      const next = redoHistory(h);
      setDoc(next.present);
      const validation = validateDocument(next.present);
      setIssues(validation.ok ? [] : validation.issues);
      if (validation.ok) controllerRef.current?.schedule(next.present, controllerRef.current.getServerRevision());
      return next;
    });
  }, [canEdit]);

  // Keyboard: Ctrl/Cmd+Z undo, Shift+Ctrl/Cmd+Z redo (outside text inputs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) handleRedo();
      else handleUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo, handleRedo]);

  const refreshVersions = useCallback(async () => {
    try {
      const detail = await getFormDetail(workspaceId, formId);
      setVersions(
        detail.versions.map((v) => ({ published_version_no: v.published_version_no, schema_hash: v.schema_hash, published_at: v.published_at })),
      );
    } catch {
      // Versions panel keeps last-known on failure; error surfaces via publish note.
    }
  }, [workspaceId, formId]);

  const reloadFromServer = useCallback(async () => {
    const detail = await getFormDetail(workspaceId, formId);
    const validation = validateDocument(detail.form.draft_payload);
    if (!validation.ok) {
      setIssues(validation.issues);
      return;
    }
    setDoc(validation.doc);
    setHistory(createHistory(validation.doc));
    setSelectedId(null);
    setIssues([]);
    controllerRef.current?.reload(detail.form.draft_revision);
    setServerRevision(detail.form.draft_revision);
    setSaveUi({ status: "idle" });
  }, [workspaceId, formId]);

  const handlePublish = useCallback(async () => {
    if (!canEdit) return;
    setPublishBusy(true);
    setPublishNote(null);
    try {
      const res = await publishAction({ workspaceId, formId, expectedRevision: serverRevision });
      if (res.ok) {
        setPublishNote(`Published version ${res.publishedVersion}.`);
        await refreshVersions();
      } else {
        controllerRef.current?.schedule(doc, res.currentRevision);
        setServerRevision(res.currentRevision);
        setSaveUi({ status: "conflict", serverRevision: res.currentRevision });
      }
    } catch (error) {
      setPublishNote(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setPublishBusy(false);
    }
  }, [workspaceId, formId, serverRevision, doc, refreshVersions, canEdit]);

  const handleRepublish = useCallback(
    async (publishedVersion: number) => {
      if (!canEdit) return;
      setPublishBusy(true);
      setPublishNote(null);
      try {
        const res = await republishAction({ workspaceId, formId, publishedVersion, expectedRevision: serverRevision });
        if (res.ok) {
          setPublishNote(`Rolled back by republishing as version ${res.publishedVersion}. Reloading draft…`);
          await reloadFromServer();
          await refreshVersions();
        } else {
          setServerRevision(res.currentRevision);
          setSaveUi({ status: "conflict", serverRevision: res.currentRevision });
        }
      } catch (error) {
        setPublishNote(error instanceof Error ? error.message : "Republish failed.");
      } finally {
        setPublishBusy(false);
      }
    },
    [workspaceId, formId, serverRevision, reloadFromServer, refreshVersions, canEdit],
  );

  const selected = selectedId ? listFields(doc).find((f) => f.id === selectedId) ?? null : null;
  const canSave = saveUi.status === "saved" || saveUi.status === "idle";
  const dirty = saveUi.status === "dirty" || saveUi.status === "pending" || saveUi.status === "saving";

  const preview = useMemo(() => {
    if (!showPreview) return null;
    try {
      return {
        schema: generateJsonSchema(doc) as unknown as PreviewSchema,
        uiSchema: generateUiSchema(doc) as unknown as PreviewUiSchema,
      };
    } catch {
      return null;
    }
  }, [showPreview, doc]);

  return (
    <div className="builder">
      <div className="builder-toolbar" role="toolbar" aria-label="Builder toolbar">
        <span className="badge">Your role: {role}</span>
        <span className="badge" aria-live="polite">
          {saveUi.status === "saved" && !dirty ? "Saved" : null}
          {saveUi.status === "saving" || saveUi.status === "pending" ? "Saving…" : null}
          {saveUi.status === "dirty" ? "Unsaved changes" : null}
          {saveUi.status === "idle" ? "Draft" : null}
          {saveUi.status === "error" ? "Save error" : null}
          {saveUi.status === "conflict" ? "Conflict" : null}
        </span>
        <span className="muted">rev {serverRevision}</span>
        <button type="button" className="secondary" onClick={handleUndo} disabled={!canEdit || !canUndo(history)} aria-label="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" className="secondary" onClick={handleRedo} disabled={!canEdit || !canRedo(history)} aria-label="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
        <button type="button" className="secondary" onClick={() => controllerRef.current?.flush()} disabled={!canEdit || !dirty}>
          Save now
        </button>
        <button type="button" onClick={() => void handlePublish()} disabled={publishBusy || !canSave || dirty || !canEdit}>
          {publishBusy ? "Publishing…" : "Publish"}
        </button>
        <button type="button" className="secondary" onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>
          {showPreview ? "Hide preview" : "Preview"}
        </button>
      </div>

      {saveUi.status === "error" ? (
        <p role="alert" className="error">
          {saveUi.error} <button type="button" className="secondary" onClick={() => controllerRef.current?.flush()}>Retry</button>
        </p>
      ) : null}
      {saveUi.status === "conflict" ? (
        <div role="alert" className="error">
          <p>
            Someone changed this form while you were editing (server revision {saveUi.serverRevision}). Your changes are
            still here — nothing was overwritten.
          </p>
          <p className="row">
            <button type="button" onClick={() => controllerRef.current?.retry()}>
              Keep my changes (retry on latest)
            </button>
            <button type="button" className="secondary" onClick={() => void reloadFromServer()}>
              Reload server version (discard my edits)
            </button>
          </p>
        </div>
      ) : null}
      {publishNote ? <p role="status">{publishNote}</p> : null}
      {issues.length > 0 ? (
        <div role="alert" className="error">
          <p>Fix validation errors to save ({issues.length}):</p>
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.fieldId ? (
                  <button type="button" className="secondary" onClick={() => setSelectedId(issue.fieldId ?? null)}>
                    Go to field
                  </button>
                ) : null}{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="builder-grid">
        {!canEdit ? (
          <p role="note" className="muted">
            Read-only: your role cannot edit this form. Changes are validated server-side regardless.
          </p>
        ) : null}
        <section aria-label="Field palette" className="builder-palette">
          <FieldPalette onAdd={handleAdd} disabled={!canEdit} />
        </section>
        <section aria-label="Form canvas" className="builder-canvas">
          <FormCanvas
            doc={doc}
            selectedId={selectedId}
            editable={canEdit}
            onSelect={setSelectedId}
            onMove={handleMove}
            onDelete={handleDelete}
          />
        </section>
        <section aria-label="Properties" className="builder-inspector">
          <FieldInspector
            field={selected}
            canEdit={canEdit}
            versions={versions}
            republishBusy={publishBusy}
            onPatch={(fieldId, patch: FieldPatch) => {
              try {
                applyLocal(updateField(doc, fieldId, patch).doc);
              } catch (error) {
                setIssues([{ message: error instanceof Error ? error.message : "Property update failed." }]);
              }
            }}
            onRepublish={(v) => void handleRepublish(v)}
          />
        </section>
      </div>

      {showPreview && preview ? (
        <section aria-label="Renderer preview" className="card">
          <h2>Preview (read-only check via the renderer boundary)</h2>
          <FormosForm
            schema={preview.schema}
            uiSchema={preview.uiSchema}
            validate={(data) => {
              const result = validateSubmission(doc, data);
              if (result.ok) return { ok: true, values: result.values };
              return { ok: false, errors: result.errors, errorSchema: toRjsfErrorSchema(result.errors) };
            }}
            onValidSubmit={(values) => setPreviewResult(`Valid ✓ normalized: ${JSON.stringify(values)}`)}
            onInvalidSubmit={(errors) => setPreviewResult(`Invalid: ${errors.map((e) => `${e.key} (${e.code})`).join("; ")}`)}
          />
          {previewResult ? <p role="status">{previewResult}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
