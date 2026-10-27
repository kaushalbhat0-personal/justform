import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Migration 0004: thin `public` wrappers delegate 1:1 to the frozen
 * `formos.*` control plane so PostgREST (public-schema only) can reach them.
 * Proves, under the least-privilege app role, that the public surface behaves
 * identically: same success paths, same denial errors, no extra logic.
 */

const A = { alice: uuid(1), bob: uuid(2), dave: uuid(4) };
const W = uuid(10);
const E = { alice: "alice@example.test", bob: "bob@example.test", dave: "dave@example.test" };

describe("Phase 1: public RPC wrappers (0004)", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
  }, 30000);

  it("public.create_workspace delegates and mints the owner membership", async () => {
    const rows = (await t.asUser(
      A.alice,
      `SELECT public.create_workspace($1, $2, 'Acme', 'acme') AS id`,
      [W, uuid(11)],
      E.alice,
    )) as Array<{ id: string }>;
    expect(rows[0]?.id).toBe(W);
    const m = (await t.asSuperuser(`SELECT role FROM public.memberships WHERE workspace_id=$1 AND user_id=$2`, [
      W,
      A.alice,
    ])) as Array<{ role: string }>;
    expect(m[0]?.role).toBe("owner");
    await expect(t.asUser(null, `SELECT public.create_workspace($1,$2,'X','x')`, [uuid(70), uuid(71)])).rejects.toThrow(
      /authentication required/,
    );
  });

  it("public.set_role enforces the same admin rules as formos.set_role", async () => {
    await t.asUser(A.alice, `SELECT public.create_workspace($1, $2, 'Acme', 'acme')`, [W, uuid(11)], E.alice);
    await t.asSuperuser(`INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'viewer')`, [
      uuid(12),
      W,
      A.bob,
    ]);
    await expect(t.asUser(A.bob, `SELECT public.set_role($1,$2,'viewer')`, [W, A.alice], E.bob)).rejects.toThrow(
      /admin required/,
    );
    await t.asUser(A.alice, `SELECT public.set_role($1,$2,'builder')`, [W, A.bob], E.alice);
    const m = (await t.asSuperuser(`SELECT role FROM public.memberships WHERE workspace_id=$1 AND user_id=$2`, [
      W,
      A.bob,
    ])) as Array<{ role: string }>;
    expect(m[0]?.role).toBe("builder");
  });

  it("public.accept_invitation enforces single-use, email binding, expiry", async () => {
    await t.asUser(A.alice, `SELECT public.create_workspace($1, $2, 'Acme', 'acme')`, [W, uuid(11)], E.alice);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    await t.asUser(
      A.alice,
      `INSERT INTO public.invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,$3,'viewer',$4,'2099-01-01T00:00:00Z')`,
      [uuid(60), W, E.dave, hash],
      E.alice,
    );
    const ws = (await t.asUser(A.dave, `SELECT public.accept_invitation($1,$2) AS ws`, [hash, uuid(70)], E.dave)) as Array<{
      ws: string;
    }>;
    expect(ws[0]?.ws).toBe(W);
    await expect(t.asUser(A.dave, `SELECT public.accept_invitation($1,$2)`, [hash, uuid(71)], E.dave)).rejects.toThrow(
      /invalid or expired/,
    );
  });
});
