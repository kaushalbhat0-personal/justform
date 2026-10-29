import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./ids.js";
export { IntakeUnavailableError, callSubmitSubmission, getIntakeSql, resetIntakeClient, type IntakeReceipt } from "./intake.js";
export { getServiceClient, resetServiceClient } from "./service.js";
export {
  callClaimDeliveries,
  callRecordDelivery,
  callTickFanout,
  getTickSql,
  resetTickClient,
  TickUnavailableError,
  type ClaimedDelivery,
  type RecordDeliveryReceipt,
  type TickFanoutReceipt,
} from "./tick.js";
export {
  API_KEY_SCOPES,
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateApiKey,
  hashApiKey,
  isCronAuthorized,
  isValidScope,
  parseApiKey,
  verifyApiKeyHash,
  type ApiScope,
} from "./secrets.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path to ordered migration files (supabase/ is the source of truth). */
export const MIGRATIONS_DIR = join(here, "..", "..", "..", "supabase", "migrations");

export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}
