import { describe, expect, it } from "vitest";
import { publicEnv, validateEnv } from "./env.js";

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "https://xyzcompany.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-1234567890",
  APP_URL: "http://localhost:3000",
};

describe("validateEnv", () => {
  it("accepts a valid local env without secrets", () => {
    const result = validateEnv({ ...base, APP_ENV: "local" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.env.APP_ENV).toBe("local");
  });

  it("rejects missing public vars with clear errors", () => {
    const result = validateEnv({ APP_URL: "http://localhost:3000" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.join(" ")).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("flags placeholder secrets and enforces requireSecrets", () => {
    const lax = validateEnv(base);
    expect(lax.ok).toBe(true);
    expect(lax.missingSecrets).toContain("CRON_SECRET");
    const strict = validateEnv(base, { requireSecrets: true });
    expect(strict.ok).toBe(false);
  });

  it("narrows to the browser-safe subset only", () => {
    const result = validateEnv({ ...base, SUPABASE_SERVICE_ROLE_KEY: "shh", DATABASE_URL: "postgres://x" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(publicEnv(result.env)).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: base.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: base.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
  });
});
