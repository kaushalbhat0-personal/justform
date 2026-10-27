import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken, invitationLink } from "./inviteToken";

describe("invitation tokens", () => {
  it("generates 256-bit base64url tokens with deterministic hashes", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashInvitationToken(a.token));
    expect(a.hash).toHaveLength(64);
    expect(a.token).not.toContain("=");
  });

  it("builds accept links without leaking anything else", () => {
    expect(invitationLink("https://app.example/", "tok")).toBe("https://app.example/app/invite/tok");
  });
});
