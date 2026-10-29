import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ApiScope } from "@formos/database";

const { authenticateApiKey } = await import("./auth");
const { requireScope } = await import("./scope");
const { ApiError } = await import("./envelope");
const { resetRateLimits } = await import("../public/rateLimit");
const { generateApiKey } = await import("@formos/database");

vi.mock("@formos/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@formos/database")>();
  const keyByPrefix: Record<string, { id: string; workspace_id: string; secret_hash: string; scopes: string[]; revoked_at: string | null }> = {};
  return {
    ...actual,
    __testKeys: keyByPrefix,
    getServiceClient: () => ({
      from: (table: string) => {
        if (table !== "api_keys") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_col: string, prefix: string) => ({
              maybeSingle: async () => {
                const row = keyByPrefix[prefix];
                if (!row) return { data: null, error: null };
                return {
                  data: {
                    id: row.id,
                    workspace_id: row.workspace_id,
                    secret_hash: row.secret_hash,
                    scopes: row.scopes,
                    revoked_at: row.revoked_at,
                  },
                  error: null,
                };
              },
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      },
    }),
  };
});

function req(headers: Record<string, string>, ip = "9.9.9.9") {
  return { headers: new Headers(headers), ip };
}

async function testDb() {
  const db = (await import("@formos/database")) as unknown as {
    __testKeys: Record<string, { id: string; workspace_id: string; secret_hash: string; scopes: string[]; revoked_at: string | null }>;
  };
  return db.__testKeys;
}

describe("API key authentication", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("authenticates a valid key and binds workspace + scopes", async () => {
    const { hashApiKey: h } = await import("@formos/database");
    const keys = await testDb();
    const { fullKey, prefix } = generateApiKey();
    keys[prefix] = { id: "key-1", workspace_id: "ws-1", secret_hash: h(fullKey), scopes: ["forms:read", "submissions:read"], revoked_at: null };
    const { principal } = await authenticateApiKey(req({ authorization: `Bearer ${fullKey}` }));
    expect(principal).toMatchObject({ keyId: "key-1", workspaceId: "ws-1" });
    expect(principal.scopes).toEqual(["forms:read", "submissions:read"]);
  });

  it("rejects missing, malformed, unknown, wrong-secret and revoked keys", async () => {
    const { hashApiKey: h } = await import("@formos/database");
    const keys = await testDb();
    const { fullKey, prefix } = generateApiKey();
    keys[prefix] = { id: "key-2", workspace_id: "ws-1", secret_hash: h(fullKey), scopes: ["forms:read"], revoked_at: null };

    for (const headers of [{}, { authorization: "Token abc" }, { authorization: "Bearer not-a-key" }]) {
      await expect(authenticateApiKey(req(headers))).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    }
    // Unknown prefix.
    const other = generateApiKey();
    await expect(authenticateApiKey(req({ authorization: `Bearer ${other.fullKey}` }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Wrong secret, right prefix.
    const tampered = `${fullKey.slice(0, -1)}${fullKey.endsWith("A") ? "B" : "A"}`;
    await expect(authenticateApiKey(req({ authorization: `Bearer ${tampered}` }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // Revoked.
    const revoked = keys[prefix]; if (revoked) revoked.revoked_at = new Date().toISOString();
    await expect(authenticateApiKey(req({ authorization: `Bearer ${fullKey}` }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("scope gate", () => {
  it("allows listed scopes and denies the rest without leaking detail", () => {
    const principal = { keyId: "k", workspaceId: "w", scopes: ["forms:read"] as ApiScope[] };
    expect(() => requireScope(principal, "forms:read")).not.toThrow();
    try {
      requireScope(principal, "submissions:read");
      expect.unreachable("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as { code: string; status: number }).code).toBe("FORBIDDEN");
      expect((error as { code: string; status: number }).status).toBe(403);
      expect(JSON.stringify(error)).not.toContain("ws-");
    }
  });
});
