import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * S3 — RLS / security spike (implementation-gated).
 * Proves against real Postgres semantics (PGlite: RLS, SECURITY DEFINER,
 * triggers, advisory behavior) under a least-privilege role:
 *   member isolation · workspace isolation · role enforcement ·
 *   immutable workspace_id · deny-by-default · no service-role in user paths.
 *
 * Seeding uses the superuser handle (documented test-only). Every assertion
 * runs as `app_user` (non-superuser, inheriting `authenticated` grants —
 * the same posture as PostgREST in production).
 */

const U = {
  alice: uuid(1),
  bob: uuid(2),
  carol: uuid(3),
  dave: uuid(4),
  stranger: uuid(5),
  wsA: uuid(10),
  wsB: uuid(20),
  mAliceA: uuid(11),
  mBobA: uuid(12),
  mCarolB: uuid(21),
};

async function fixture(t: TenantDb): Promise<void> {
  // Alice owns wsA; Bob is viewer in wsA; Carol owns wsB. Dave is a memberless user.
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme')`, [U.wsA, U.mAliceA]);
  await t.asUser(U.carol, `SELECT formos.create_workspace($1, $2, 'Beta', 'beta')`, [U.wsB, U.mCarolB]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`,
    [U.mBobA, U.wsA, U.bob],
  );
}

describe("S3 gate: tenant isolation", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("PASS member isolation: members see own workspace, nothing else", async () => {
    const aliceRows = (await t.asUser(U.alice, `SELECT id FROM public.workspaces ORDER BY id`)) as Array<{ id: string }>;
    expect(aliceRows.map((r) => r.id)).toEqual([U.wsA]);
    const carolRows = (await t.asUser(U.carol, `SELECT id FROM public.workspaces ORDER BY id`)) as Array<{ id: string }>;
    expect(carolRows.map((r) => r.id)).toEqual([U.wsB]);
  });

  it("PASS non-member access denied: stranger reads nothing", async () => {
    expect(await t.asUser(U.stranger, `SELECT id FROM public.workspaces`)).toEqual([]);
    expect(await t.asUser(U.stranger, `SELECT id FROM public.memberships`)).toEqual([]);
    expect(await t.asUser(U.stranger, `SELECT id FROM public.resource_grants`)).toEqual([]);
    expect(await t.asUser(null, `SELECT id FROM public.workspaces`)).toEqual([]);
  });

  it("PASS cross-workspace read fails even with a known id (RLS backstop for URL-override)", async () => {
    // Simulates an app resolving /v1/workspaces/<wsB>/forms/<id-of-A>: composite scoping first…
    const scoped = (await t.asUser(U.carol, `SELECT id FROM public.memberships WHERE workspace_id = $1 AND user_id = $2`, [
      U.wsB,
      U.alice,
    ])) as unknown[];
    expect(scoped).toEqual([]);
    // …and RLS denies the raw cross-tenant row even if the app passed the wrong workspace.
    const raw = (await t.asUser(U.carol, `SELECT id FROM public.memberships WHERE id = $1`, [U.mAliceA])) as unknown[];
    expect(raw).toEqual([]);
  });

  it("PASS cross-workspace write fails: RLS silent-deny, privilege hard-deny", async () => {
    await t.db.query(`SET ROLE app_user`);
    await t.db.query(`SET app.test_uid = '${U.carol}'`);
    try {
      // UPDATE has a table grant but no permitting policy → RLS denies silently (no oracle).
      const upd = await t.db.query(`UPDATE public.memberships SET role = 'owner' WHERE id = '${U.mAliceA}' RETURNING id`);
      expect(upd.rows).toEqual([]);
      // DELETE has no grant at all → privilege error. Both shapes = write fails.
      await expect(t.db.query(`DELETE FROM public.memberships WHERE id = '${U.mAliceA}'`)).rejects.toThrow(
        /denied|permission/,
      );
    } finally {
      await t.db.query(`RESET ROLE`);
    }
  });

  it("PASS workspace_id is immutable (trigger fires even for privileged writers)", async () => {
    // App roles cannot reach the trigger: UPDATE has a grant but no permitting
    // policy, so RLS denies first with zero rows (fail-closed ordering proven here).
    const silent = (await t.asUser(U.alice, `UPDATE public.memberships SET workspace_id = $1 WHERE id = $2 RETURNING id`, [
      U.wsB,
      U.mAliceA,
    ])) as unknown[];
    expect(silent).toEqual([]);
    // The trigger itself is proven via a privileged writer on a real row.
    const gid = uuid(59);
    await t.asUser(U.alice, `SELECT formos.create_grant($1,$2,'form',$3,$4,$5,$6)`, [
      gid,
      U.wsA,
      uuid(40),
      U.bob,
      ["read"],
      "2099-01-01T00:00:00Z",
    ]);
    await expect(
      t.asSuperuser(`UPDATE public.resource_grants SET workspace_id = $1 WHERE id = $2`, [U.wsB, gid]),
    ).rejects.toThrow(/immutable/);
    await expect(
      t.asSuperuser(`UPDATE public.memberships SET workspace_id = $1 WHERE id = $2`, [U.wsB, U.mAliceA]),
    ).rejects.toThrow(/immutable/);
  });

  it("PASS deny-by-default: direct membership/grant writes denied without RPC", async () => {
    // INSERT has no table grant → hard privilege error.
    await expect(
      t.asUser(U.alice, `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`, [
        uuid(31),
        U.wsA,
        U.dave,
      ]),
    ).rejects.toThrow(/denied|permission|policy/);
    // UPDATE has a grant but no permitting policy → RLS silent deny (zero rows, no oracle).
    const upd = (await t.asUser(U.alice, `UPDATE public.memberships SET role = 'admin' WHERE id = $1 RETURNING id`, [
      U.mBobA,
    ])) as unknown[];
    expect(upd).toEqual([]);
    // Grants table: no INSERT grant → hard error.
    await expect(
      t.asUser(U.alice, `INSERT INTO public.resource_grants (id, workspace_id, resource_type, resource_id, grantee_user_id, actions, expires_at, created_by) VALUES ($1,$2,'form',$3,$4,$5,$6,$7)`, [
        uuid(32),
        U.wsA,
        uuid(40),
        U.bob,
        ["read"],
        "2099-01-01T00:00:00Z",
        U.alice,
      ]),
    ).rejects.toThrow(/denied|permission|policy/);
  });
});

describe("S3 gate: role enforcement + RPC-only control plane", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("PASS role floor: viewer cannot rename workspace, owner path allows", async () => {
    await t.db.query(`SET ROLE app_user`);
    await t.db.query(`SET app.test_uid = '${U.bob}'`);
    try {
      const upd = await t.db.query(`UPDATE public.workspaces SET name = 'Hacked' WHERE id = '${U.wsA}' RETURNING id`);
      expect(upd.rows).toEqual([]);
    } finally {
      await t.db.query(`RESET ROLE`);
    }
    const still = (await t.asUser(U.alice, `SELECT name FROM public.workspaces WHERE id = $1`, [U.wsA])) as Array<{
      name: string;
    }>;
    expect(still[0]?.name).toBe("Acme");
  });

  it("PASS set_role: admin rules — no self-target, no at-or-above-rank grants", async () => {
    // Bob (viewer) cannot change anyone's role.
    await expect(t.asUser(U.bob, `SELECT formos.set_role($1, $2, 'viewer')`, [U.wsA, U.alice])).rejects.toThrow(
      /admin required|not a member/,
    );
    // Alice (owner) cannot self-target.
    await expect(t.asUser(U.alice, `SELECT formos.set_role($1, $2, 'admin')`, [U.wsA, U.alice])).rejects.toThrow(
      /self role change/,
    );
    // Owner promotes Bob viewer → builder.
    await t.asUser(U.alice, `SELECT formos.set_role($1, $2, 'builder')`, [U.wsA, U.bob]);
    const role = (await t.asSuperuser(`SELECT role FROM public.memberships WHERE id = $1`, [U.mBobA])) as Array<{
      role: string;
    }>;
    expect(role[0]?.role).toBe("builder");
  });

  it("PASS grants are RPC-minted only, with validation", async () => {
    // Direct INSERT already proven denied; RPC path for admin works.
    const gid = uuid(50);
    const future = "2099-01-01T00:00:00Z";
    await t.asUser(U.alice, `SELECT formos.create_grant($1,$2,'form',$3,$4,$5,$6)`, [
      gid,
      U.wsA,
      uuid(40),
      U.bob,
      ["read", "update"],
      future,
    ]);
    const got = (await t.asUser(U.bob, `SELECT id FROM public.resource_grants WHERE id = $1`, [gid])) as Array<{
      id: string;
    }>;
    expect(got).toHaveLength(1);
    // Viewer cannot mint.
    await expect(
      t.asUser(U.bob, `SELECT formos.create_grant($1,$2,'form',$3,$4,$5,$6)`, [uuid(51), U.wsA, uuid(40), U.bob, ["read"], future]),
    ).rejects.toThrow(/admin required/);
    // Non-member grantee rejected.
    await expect(
      t.asUser(U.alice, `SELECT formos.create_grant($1,$2,'form',$3,$4,$5,$6)`, [
        uuid(52),
        U.wsA,
        uuid(40),
        U.stranger,
        ["read"],
        future,
      ]),
    ).rejects.toThrow(/not an active member/);
    // Missing/past expiry rejected.
    await expect(
      t.asUser(U.alice, `SELECT formos.create_grant($1,$2,'form',$3,$4,$5,$6)`, [
        uuid(53),
        U.wsA,
        uuid(40),
        U.bob,
        ["read"],
        "2000-01-01T00:00:00Z",
      ]),
    ).rejects.toThrow(/expiry/);
    // Revocation is admin-only and effective.
    await expect(t.asUser(U.bob, `SELECT formos.revoke_grant($1,$2)`, [U.wsA, gid])).rejects.toThrow(/admin required/);
    await t.asUser(U.alice, `SELECT formos.revoke_grant($1,$2)`, [U.wsA, gid]);
    expect(await t.asUser(U.bob, `SELECT id FROM public.resource_grants WHERE id = $1`, [gid])).toEqual([]);
  });

  it("PASS audit log is append-only", async () => {
    const aid = uuid(60);
    await t.asUser(U.alice, `INSERT INTO public.audit_log (id, workspace_id, actor_id, action, resource_type, resource_id) VALUES ($1,$2,$3,'member.role_changed','membership',$4)`, [
      aid,
      U.wsA,
      U.alice,
      U.mBobA,
    ]);
    const rows = (await t.asUser(U.alice, `SELECT id FROM public.audit_log WHERE id = $1`, [aid])) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    await expect(t.asUser(U.alice, `UPDATE public.audit_log SET action = 'x' WHERE id = $1`, [aid])).rejects.toThrow(
      /denied|policy/,
    );
    await expect(t.asUser(U.alice, `DELETE FROM public.audit_log WHERE id = $1`, [aid])).rejects.toThrow(/denied|policy/);
    expect(await t.asUser(U.stranger, `SELECT id FROM public.audit_log`)).toEqual([]);
  });

  it("PASS invitations are admin-scoped; unauthenticated creation fails", async () => {
    await expect(t.asUser(null, `SELECT formos.create_workspace($1,$2,'X','x')`, [uuid(70), uuid(71)])).rejects.toThrow(
      /authentication required/,
    );
    const inv = uuid(72);
    await t.asUser(U.alice, `INSERT INTO public.invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,'n@x.co','viewer','h','2099-01-01')`, [
      inv,
      U.wsA,
    ]);
    expect(await t.asUser(U.stranger, `SELECT id FROM public.invitations`)).toEqual([]);
    await expect(
      t.asUser(U.bob, `INSERT INTO public.invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES ($1,$2,'m@x.co','viewer','h','2099-01-01')`, [
        uuid(73),
        U.wsA,
      ]),
    ).rejects.toThrow(/denied|policy/);
  });
});
