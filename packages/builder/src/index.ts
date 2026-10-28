/**
 * @formos/builder — builder foundation logic (framework-agnostic).
 *
 * Owns: canonical document operations, field capabilities, editor history,
 * autosave control. React shell lives in apps/web. No React, no RJSF, no
 * Supabase imports here — document ops consume @formos/forms-engine only.
 */
export {
  FIELD_CAPABILITIES,
  PALETTE_ORDER,
  createDefaultField,
  type ConstraintKind,
  type FieldCapability,
  type MvpFieldType,
} from "./capabilities.js";
export {
  newFieldId,
  uniqueKey,
  findFieldLocation,
  listFields,
  addField,
  updateField,
  moveField,
  moveFieldTo,
  deleteField,
  validateDocument,
  type FieldLocation,
  type AddFieldTarget,
  type FieldPatch,
  type DeleteBlocker,
  type DeleteResult,
  type DocumentIssue,
} from "./document.js";
export {
  createHistory,
  pushHistory,
  canUndo,
  canRedo,
  undoHistory,
  redoHistory,
  type History,
} from "./history.js";
export { AutosaveController, type SaveStatus, type SaveAttempt, type AutosaveEvents } from "./autosave.js";
