import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export * from "./ids.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path to ordered migration files (supabase/ is the source of truth). */
export const MIGRATIONS_DIR = join(here, "..", "..", "..", "supabase", "migrations");

export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}
