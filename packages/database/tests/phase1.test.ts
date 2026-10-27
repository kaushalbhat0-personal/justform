import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Phase 1 control-plane tests: profiles self-provisioning, invitation
 * lifecycle (hash-bound, expiring, single-use, email-bound), member removal.
 * Token hashing mirrors the API route (SHA-256 hex of a 256-bit token).
 */

const A = { alice: uuid(1), bob: uuid(2), dave: uuid(4), stranger: uuid(5) };
const W = uuid(10);
const E = { alice: "alice@example.test", bob: "bob@example.test", dave: "dave@example.test" };

const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

async function fixture(t: TenantDb): Promise<void> {
  await t.asUser(A.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme')`, [W, uuid(11)], E.alice);
  await t.asSuperuser(`INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'viewer')`, [
    uuid(12),
    W,
    A.bob,
  ]);
}

describe("Phase 1: profiles", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("users provision exactly their own profile row", async () => {
    await t.asUser(A.dave, `INSERT INTO public.profiles (id, email, display_name) VALUES ($1,$2,'Dave')`, [A.dave, E.dave], E.dave);
    const rows = (await t.asUser(A.dave, `SELECT id FROM public.profiles`)) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([A.dave]);
    await expect(
      t.asUser(A.dave, `INSERT INTO public.profiles (id, email) VALUES ($1,$2)`, [A.stranger, "s@x"], E.dave),
    ).rejects.toThrow(/denied|policy|permission/);
  });
});

describe("Phase 1: invitations", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  const invite = async (email: string, role: string, expiresAt: string): Promise<{ id: string; hash: string }> => {
    const token = randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const id = uuid(60 + Math.floor(Math.random() * 100));
    await t.asUser(A.alice, `INSERT INTO public.invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, W, email, role, hash, expiresAt], E.alice);
    return { id, hash };
  };

  it("admin creates, invitee accepts, invite is consumed (replay denied)", async () => {
    const { hash } = await invite(E.dave, "builder", "2099-01-01T00:00:00Z");
    const ws = (await t.asUser(A.dave, `SELECT formos.accept_invitation($1,$2) AS ws`, [hash, uuid(70)], E.dave)) as Array<{
      ws: string;
    }>;
    expect(ws[0]?.ws).toBe(W);
    const m = (await t.asSuperuser(`SELECT role FROM public.memberships WHERE workspace_id=$1 AND user_id=$2`, [W, A.dave])) as Array<{ role: string }>;
    expect(m[0]?.role).toBe("builder");
    await expect(t.asUser(A.dave, `SELECT formos.accept_invitation($1,$2)`, [hash, uuid(71)], E.dave)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("email mismatch, expiry, and unknown hashes deny uniformly", async () => {
    const { hash } = await invite("other@example.test", "viewer", "2099-01-01T00:00:00Z");
    await expect(t.asUser(A.dave, `SELECT formos.accept_invitation($1,$2)`, [hash, uuid(72)], E.dave)).rejects.toThrow(
      /mismatch|invalid/,
    );
    const expired = await invite(E.dave, "viewer", "2000-01-01T00:00:00Z");
    await expect(t.asUser(A.dave, `SELECT formos.accept_invitation($1,$2)`, [expired.hash, uuid(73)], E.dave)).rejects.toThrow(
      /invalid or expired/,
    );
    await expect(t.asUser(A.dave, `SELECT formos.accept_invitation($1,$2)`, ["0".repeat(64), uuid(74)], E.dave)).rejects.toThrow(
      /invalid or expired/,
    );
  });

  it("viewer cannot invite; unauthenticated cannot accept", async () => {
    await expect(
      t.asUser(A.bob, `INSERT INTO public.invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,'x@y','viewer','h','2099-01-01')`, [uuid(80), W], E.bob),
    ).rejects.toThrow(/denied|policy|permission/);
    await expect(t.asUser(null, `SELECT formos.accept_invitation($1,$2)`, ["a".repeat(64), uuid(81)])).rejects.toThrow(
      /authentication required/,
    );
  });
});

describe("Phase 1: member removal", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("admin removes viewer; self/owner/unauthorized removal denied", async () => {
    await t.asUser(A.alice, `SELECT formos.remove_member($1,$2)`, [W, A.bob], E.alice);
    expect(await t.asSuperuser(`SELECT id FROM public.memberships WHERE user_id=$1`, [A.bob])).toEqual([]);
    await expect(t.asUser(A.alice, `SELECT formos.remove_member($1,$2)`, [W, A.alice], E.alice)).rejects.toThrow(/self removal/);
    await expect(t.asUser(A.alice, `SELECT formos.remove_member($1,$2)`, [W, A.alice], E.alice)).rejects.toThrow(/self removal/);
    // owner removal requires transfer flow
    const owner2 = uuid(6);
    await t.asSuperuser(`INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'owner')`, [uuid(82), W, owner2]);
    await expect(t.asUser(A.alice, `SELECT formos.remove_member($1,$2)`, [W, owner2], E.alice)).rejects.toThrow(/ownership transfer/);
    // viewer cannot remove anyone
    await expect(t.asUser(A.bob, `SELECT formos.remove_member($1,$2)`, [W, A.alice], E.bob)).rejects.toThrow(/admin required/);
  });
});
