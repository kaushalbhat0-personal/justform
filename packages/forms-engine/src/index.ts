/**
 * @formos/forms-engine — canonical FORMOS schema, derivations, and adapters.
 *
 * Source-of-truth direction (one way only):
 *   canonical schema → JSON Schema → RJSF renderer
 *   canonical schema → uiSchema     → RJSF renderer
 *   canonical schema → Zod          → application validation (client + server)
 *
 * Never reversed: Zod / JSON Schema / RJSF are derived artifacts, never inputs.
 */
export {
  SCHEMA_VERSION,
  MVP_FIELD_TYPES,
  type MvpFieldType,
  type FieldOption,
  type TextValidation,
  type NumberValidation,
  type EmailValidation,
  type PhoneValidation,
  type ChoiceValidation,
  type MultiValidation,
  type DateValidation,
  type TimeValidation,
  type FileValidation,
  type FormField,
  type ShortTextField,
  type LongTextField,
  type EmailField,
  type NumberField,
  type PhoneField,
  type DropdownField,
  type RadioField,
  type CheckboxField,
  type DateField,
  type TimeField,
  type FileField,
  type HiddenField,
  type CustomField,
  type FormSection,
  type FormPage,
  type ConditionOp,
  type Condition,
  type ConditionGroup,
  type RuleActionKind,
  type RuleAction,
  type RuleWhen,
  type Rule,
  type CalcNode,
  type Calculation,
  type FormSettings,
  type CanonicalForm,
  type PublishedSnapshot,
} from "./schema.js";
export {
  CanonicalError,
  migrateToCurrent,
  stableStringify,
  hashCanonical,
  createPublishedSnapshot,
} from "./migrate.js";
export { parseCanonicalForm, collectFields, indexFieldsByKey } from "./parse.js";
export { generateJsonSchema, type JsonSchemaDocument, type JsonSchemaNode } from "./jsonSchema.js";
export { generateUiSchema, type UiSchema, type UiFieldSchema } from "./uiSchema.js";
export {
  generateZod,
  validateSubmission,
  normalizePhone,
  type SubmissionSuccess,
  type SubmissionFailure,
} from "./zod.js";
export {
  toFormValidationErrors,
  toRjsfErrorSchema,
  zodIssuesToErrorSchema,
  type FormValidationError,
  type RjsfErrorSchema,
} from "./errors.js";
export {
  validateRules,
  evaluateCondition,
  evaluateConditionGroup,
  evaluateRule,
  resolveFieldState,
  type RuleProblems,
  type FieldState,
} from "./rules.js";
export {
  CALC_STEP_CAP,
  collectRefs,
  validateCalculations,
  evaluateCalculations,
  type CalcValue,
  type CalcResult,
} from "./calculations.js";
export { contactExample } from "./examples.js";
