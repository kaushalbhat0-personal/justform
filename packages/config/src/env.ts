import { z } from "zod";

/**
 * Environment contract (single source of truth).
 * Classification: public (NEXT_PUBLIC_* browser-safe) | server | secret.
 * Secrets must never be read by browser bundles — enforced by lint/guard rules
 * in apps/web (Phase 1+) which may only import the public subset.
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(16),
});

const serverSchema = z.object({
  APP_ENV: z.enum(["local", "preview", "production"]).default("local"),
  APP_URL: z.string().url(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(16).optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required for migrations/workers").optional(),
  // Optional direct-connection override for the intake_caller path (e.g. the
  // Supavisor pooler host when `db.<ref>.supabase.co` does not resolve).
  INTAKE_DATABASE_URL: z.string().min(1).optional(),
  // Optional direct-connection override for the Stage 0 tick pump (same
  // shape as DATABASE_URL, superuser over session-mode pooler accepted).
  // The pump RPCs have no PostgREST surface, so this path is mandatory.
  TICK_DATABASE_URL: z.string().min(1).optional(),
  // AES-256-GCM key (64 hex chars) for webhook signing secrets at rest.
  // Required at runtime for webhook create/rotate/delivery; absent in tests
  // that never touch secrets (validation stays optional to avoid breaking
  // unrelated boot paths — the tick route fails closed without it).
  WEBHOOK_ENCRYPTION_KEY: z.string().optional(),
});

const secretSchema = z.object({
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be ≥32 chars").optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  INTAKE_DB_ROLE_PASSWORD: z.string().optional(),
  BILLING_PROVIDER_SECRET: z.string().optional(),
  // Optional bot-protection provider (Phase 6 boundary). When unset, forms
  // that request captcha skip verification and log a warning (fail-open is
  // documented; enforcement activates the moment the secret is configured).
  TURNSTILE_SECRET_KEY: z.string().optional(),
});

const envSchema = publicSchema.merge(serverSchema).merge(secretSchema);
export type Env = z.infer<typeof envSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;

export type EnvValidation =
  | { ok: true; env: Env; missingSecrets: string[] }
  | { ok: false; errors: string[]; missingSecrets?: string[] };

const SECRET_NAMES = [
  "CRON_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "INTAKE_DB_ROLE_PASSWORD",
  "BILLING_PROVIDER_SECRET",
] as const;

/** Validate process.env. `requireSecrets` gates boot paths that need them (tick route, workers). */
export function validateEnv(
  input: NodeJS.ProcessEnv,
  options?: { requireSecrets?: boolean },
): EnvValidation {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const missingSecrets = SECRET_NAMES.filter((n) => {
    const v = parsed.data[n as keyof Env];
    return typeof v !== "string" || v.length === 0 || v.startsWith("placeholder");
  });
  if (options?.requireSecrets && missingSecrets.length > 0) {
    return { ok: false, errors: [`missing required secrets: ${missingSecrets.join(", ")}`], missingSecrets };
  }
  return { ok: true, env: parsed.data, missingSecrets };
}

/** Narrow to the browser-safe subset. The ONLY env shape browser code may import. */
export function publicEnv(env: Env): PublicEnv {
  return {
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}
