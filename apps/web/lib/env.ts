import "server-only";
import { validateEnv, type Env } from "@formos/config";

let cached: Env | null = null;

/** Validated server environment. Throws at boot/request time on misconfiguration. */
export function serverEnv(): Env {
  if (!cached) {
    const result = validateEnv(process.env);
    if (!result.ok) throw new Error(`Invalid environment: ${result.errors.join("; ")}`);
    cached = result.env;
  }
  return cached;
}
