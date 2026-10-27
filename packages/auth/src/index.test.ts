import { describe, expect, it } from "vitest";
import { emailsMatch, getSessionUser, normalizeEmail, type AuthClientLike } from "./index.js";

const fake = (user: { id: string; email?: string | null } | null): AuthClientLike => ({
  auth: {
    getUser: async () => ({ data: { user } }),
    signOut: async () => ({ error: null }),
  },
});

describe("auth boundary", () => {
  it("returns the session user or null", async () => {
    expect(await getSessionUser(fake({ id: "u1", email: "A@x.co" }))).toEqual({ id: "u1", email: "A@x.co" });
    expect(await getSessionUser(fake(null))).toBeNull();
  });

  it("normalizes emails for invitation binding", () => {
    expect(normalizeEmail("  A@X.co ")).toBe("a@x.co");
    expect(emailsMatch("A@x.co", "a@X.CO")).toBe(true);
    expect(emailsMatch(null, "a@x.co")).toBe(false);
  });
});
