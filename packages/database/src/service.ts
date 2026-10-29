import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Privileged server-side Supabase client (service role).
 *
 * Lives in @formos/database — NOT apps/ — so the G4 browser-tree secret scan
 * stays airtight: no service-role names ever appear in browser-reachable code.
 * Import only from server routes / server actions / workers. It bypasses RLS,
 * so every query through it MUST carry an explicit workspace_id equality
 * derived from an authenticated principal (API key binding or CRON-gated
 * tick scope). There are no exceptions to this rule.
 */
let cached: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("service client unavailable: missing server configuration");
  }
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

/** Test seam: drop the cached client. */
export function resetServiceClient(): void {
  cached = null;
}
