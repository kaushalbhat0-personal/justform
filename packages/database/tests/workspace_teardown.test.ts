import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * IMPL-012 — authorized workspace teardown (migration 0019).
 *
 * Proven blockers (STEP 2): workspace DELETE cascades into immutable
 * form_versions / workflow_versions and aborts. Migration 0019 adds
 * formos.delete_workspace + a transaction-local teardown context that ONLY
 * this RPC can establish. This suite proves:
 *   1. Direct deletion / version mutation stays rejected (immutability intact).
 *   2. Owner teardown via the RPC succeeds atomically (forms + workflows).
 *   3. Non-owners / outsiders / anon stay denied and change nothing.
 *   4. Teardown of workspace A never touches workspace B (isolation).
 *   5. The bypass context alone grants nothing (RLS still denies app roles).
 */

const U = {
  alice: uuid(1),
  bob: uuid(2),
  charlie: uuid(3),
  viewer: uuid(4),
  mallory: uuid(5),
  data: uuid(6),
  wsA: uuid(10),
  wsC: uuid(11),
  wsB: uuid(12),
  mAlice: uuid(13),
  mBob: uuid(14),
  mCharlie: uuid(15),
  mViewer: uuid(16),
  mMallory: uuid(17),
  mAliceC: uuid(18),
  mData: uuid(19),
  formA: uuid(20),
  verA1: uuid(21),
  pubA: uuid(22),
  sub1: uuid(30),
  defA: uuid(40),
  formC: uuid(50),
  defC: uuid(51),
  outA: uuid(60),
  audA: uuid(61),
  useA: uuid(62),
};

const doc = {
  id: U.formA,
  key: "leave",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Leave Request" },
  settings: {},
  pages: [],
  rules: [],
  calculations: [],
  localization: {},
  notificationsRef: null,
  integrationsRef: null,
};

const CONFIG = {
  trigger: "submission.created",
  steps: [{ type: "approval", key: "approval", assignee: "unassigned" }],
};

const CHILD_TABLES = [
  "memberships",
  "invitations",
  "resource_grants",
  "audit_log",
  "forms",
  "form_versions",
  "form_publications",
  "submissions",
  "outbox",
  "api_keys",
  "webhook_endpoints",
  "webhook_deliveries",
  "usage_events",
  "workflow_definitions",
  "workflow_versions",
  "workflow_instances",
  "workflow_tasks",
] as const;

async function countWs(t: TenantDb, table: string, ws: string): Promise<number> {
  const col = table === "workspaces" ? "id" : "workspace_id";
  const rows = await t.asSuperuser(`SELECT count(*)::int AS n FROM public.${table} WHERE ${col} = $1`, [ws]);
  return (rows[0] as { n: number }).n;
}

async function fixture(t: TenantDb): Promise<void> {
  // wsA: full realistic workspace.
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Airport', 'airport-td')`, [U.wsA, U.mAlice]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role)
     VALUES ($1,$2,$3,'admin'), ($4,$2,$5,'builder'), ($6,$2,$7,'viewer'), ($8,$2,$9,'data_collaborator')`,
    [U.mBob, U.wsA, U.bob, U.mCharlie, U.charlie, U.mViewer, U.viewer, U.mData, U.data],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by)
     VALUES ($1,$2,'leave','Leave Request',$3::jsonb,$4,$4)`,
    [U.formA, U.wsA, JSON.stringify(doc), U.alice],
  );
  await t.asSuperuser(
    `INSERT INTO public.form_versions (id, form_id, workspace_id, published_version_no, schema_snapshot, schema_version, schema_hash, renderer_version, publisher_id)
     VALUES ($1,$2,$3,1,$4::jsonb,1,'h','r',$5)`,
    [U.verA1, U.formA, U.wsA, JSON.stringify(doc), U.alice],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.form_publications (id, workspace_id, form_id, form_version_id, public_id, created_by)
     VALUES ($1,$2,$3,$4,'leave-pub-td-000001',$5)`,
    [U.pubA, U.wsA, U.formA, U.verA1, U.alice],
  );
  await t.asSuperuser(
    `INSERT INTO public.submissions (id, workspace_id, form_id, publication_id, form_version_id, payload, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'{"reason":"x"}'::jsonb,'td-key-01')`,
    [U.sub1, U.wsA, U.formA, U.pubA, U.verA1],
  );
  await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
    U.defA,
    U.formA,
    JSON.stringify(CONFIG),
  ]);
  await t.asUser(U.alice, `SELECT formos.activate_workflow($1)`, [U.defA]);
  await t.asUser(U.alice, `SELECT formos.start_workflow($1)`, [U.sub1]);
  // Receipt / metadata / metering witnesses (cascade-covered, never authoritative).
  await t.asSuperuser(
    `INSERT INTO public.outbox (id, workspace_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1,$2,'submission.received','submission',$3,'{}'::jsonb)`,
    [U.outA, U.wsA, U.sub1],
  );
  await t.asSuperuser(
    `INSERT INTO public.audit_log (id, workspace_id, actor_id, action, resource_type, resource_id)
     VALUES ($1,$2,$3,'form.published','form_version',$4)`,
    [U.audA, U.wsA, U.alice, U.verA1],
  );
  await t.asSuperuser(
    `INSERT INTO public.usage_events (id, workspace_id, metric, quantity, source, source_id, period_start)
     VALUES ($1,$2,'submission',1,'intake',$3,'2026-10-01')`,
    [U.useA, U.wsA, U.sub1],
  );

  // wsC: workflow-only workspace (form + definition + version, zero form_versions).
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'WfOnly', 'wfonly-td')`, [U.wsC, U.mAliceC]);
  await t.asUser(
    U.alice,
    `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by)
     VALUES ($1,$2,'solo','Solo',$3::jsonb,$4,$4)`,
    [U.formC, U.wsC, JSON.stringify({ ...doc, id: U.formC, key: "solo" }), U.alice],
  );
  await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
    U.defC,
    U.formC,
    JSON.stringify(CONFIG),
  ]);
  await t.asUser(U.alice, `SELECT formos.activate_workflow($1)`, [U.defC]);

  // wsB: untouched control workspace owned by mallory (isolation witness).
  await t.asUser(U.mallory, `SELECT formos.create_workspace($1, $2, 'Other', 'other-td')`, [U.wsB, U.mMallory]);
}

let t: TenantDb;
beforeEach(async () => {
  t = await newTenantDb();
  await fixture(t);
});

describe("IMPL-012: direct deletion and version mutation stay blocked", () => {
  it("Case A — workspace with published form versions cannot be deleted directly", async () => {
    await expect(t.asSuperuser(`DELETE FROM public.workspaces WHERE id = $1`, [U.wsA])).rejects.toThrow(
      /immutable/,
    );
    expect(await countWs(t, "workspaces", U.wsA)).toBe(1);
    expect(await countWs(t, "form_versions", U.wsA)).toBe(1);
  });

  it("Case B — workflow-only workspace cannot be deleted directly", async () => {
    expect(await countWs(t, "workflow_versions", U.wsC)).toBe(1);
    expect(await countWs(t, "form_versions", U.wsC)).toBe(0);
    await expect(t.asSuperuser(`DELETE FROM public.workspaces WHERE id = $1`, [U.wsC])).rejects.toThrow(
      /immutable/,
    );
    expect(await countWs(t, "workspaces", U.wsC)).toBe(1);
  });

  it("version rows stay immutable for ordinary UPDATE and DELETE", async () => {
    await expect(
      t.asSuperuser(`UPDATE public.form_versions SET schema_hash = 'x' WHERE id = $1`, [U.verA1]),
    ).rejects.toThrow(/immutable/);
    await expect(t.asSuperuser(`DELETE FROM public.form_versions WHERE id = $1`, [U.verA1])).rejects.toThrow(
      /immutable/,
    );
    const wv = await t.asSuperuser(`SELECT id FROM public.workflow_versions WHERE workspace_id = $1`, [U.wsA]);
    expect(wv.length).toBe(1);
    const wvId = (wv[0] as { id: string }).id;
    await expect(
      t.asSuperuser(`UPDATE public.workflow_versions SET status = 'archived' WHERE id = $1`, [wvId]),
    ).rejects.toThrow(/immutable/);
    await expect(t.asSuperuser(`DELETE FROM public.workflow_versions WHERE id = $1`, [wvId])).rejects.toThrow(
      /immutable/,
    );
  });

  it("app roles cannot DELETE workspaces or versions directly (RLS denies before triggers)", async () => {
    // Even the owner has no direct DELETE path — teardown must go through the RPC.
    await expect(t.asUser(U.alice, `DELETE FROM public.workspaces WHERE id = $1`, [U.wsA])).rejects.toThrow(
      /permission denied|policy|denied/i,
    );
    await expect(t.asUser(U.alice, `DELETE FROM public.form_versions WHERE id = $1`, [U.verA1])).rejects.toThrow(
      /permission denied|policy|denied/i,
    );
    expect(await countWs(t, "workspaces", U.wsA)).toBe(1);
  });

  it("teardown context alone grants nothing and is per-row scoped", async () => {
    // Attacker sets the context for ANOTHER workspace, then deletes directly:
    // RLS still denies (no DELETE grant/policy on version tables).
    await t.asUser(U.alice, `SET app.formos_teardown_workspace = '${U.wsB}'`);
    try {
      await expect(t.asUser(U.alice, `DELETE FROM public.form_versions WHERE id = $1`, [U.verA1])).rejects.toThrow(
        /permission denied|policy|denied/i,
      );
    } finally {
      await t.asUser(U.alice, `RESET app.formos_teardown_workspace`);
    }
    // Attacker sets the context for the RIGHT workspace, superuser deletes:
    // per-row check still rejects because the context names a different workspace.
    // (Session SET mirrors what SET LOCAL establishes; the trigger reads both.)
    await t.asSuperuser(`SET app.formos_teardown_workspace = '${U.wsB}'`);
    try {
      await expect(t.asSuperuser(`DELETE FROM public.workspaces WHERE id = $1`, [U.wsA])).rejects.toThrow(
        /immutable/,
      );
    } finally {
      await t.asSuperuser(`RESET app.formos_teardown_workspace`);
    }
    expect(await countWs(t, "workspaces", U.wsA)).toBe(1);
  });
});

describe("IMPL-012: authorized teardown succeeds atomically", () => {
  it("owner deletes the full workspace; nothing of it remains, nothing else is touched", async () => {
    const res = await t.asUser(U.alice, `SELECT formos.delete_workspace($1)`, [U.wsA]);
    expect((res[0] as { delete_workspace: { deleted: boolean } }).delete_workspace.deleted).toBe(true);
    const ws = await t.asSuperuser(`SELECT id FROM public.workspaces WHERE id = $1`, [U.wsA]);
    expect(ws.length).toBe(0);
    for (const table of CHILD_TABLES) {
      expect(await countWs(t, table, U.wsA)).toBe(0);
    }
    // Isolation: control workspaces are fully intact.
    expect(await countWs(t, "workspaces", U.wsB)).toBe(1);
    expect(await countWs(t, "workspaces", U.wsC)).toBe(1);
    expect(await countWs(t, "workflow_versions", U.wsC)).toBe(1);
    expect(await countWs(t, "form_versions", U.wsA)).toBe(0);
  });

  it("owner deletes the workflow-only workspace via the public wrapper", async () => {
    const res = await t.asUser(U.alice, `SELECT public.delete_workspace($1)`, [U.wsC]);
    expect((res[0] as { delete_workspace: { deleted: boolean } }).delete_workspace.deleted).toBe(true);
    expect(await countWs(t, "workspaces", U.wsC)).toBe(0);
    for (const table of CHILD_TABLES) {
      expect(await countWs(t, table, U.wsC)).toBe(0);
    }
    expect(await countWs(t, "workspaces", U.wsA)).toBe(1);
    expect(await countWs(t, "workspaces", U.wsB)).toBe(1);
  });
});

describe("IMPL-012: unauthorized teardown is denied and changes nothing", () => {
  const denied = [
    ["admin", U.bob],
    ["builder", U.charlie],
    ["viewer", U.viewer],
    ["data_collaborator", U.data],
    ["outsider-owner-of-B", U.mallory],
  ] as const;

  for (const [role, user] of denied) {
    it(`${role} cannot delete the workspace`, async () => {
      await expect(t.asUser(user, `SELECT formos.delete_workspace($1)`, [U.wsA])).rejects.toThrow(
        /workspace deletion requires workspace owner/,
      );
    });
  }

  it("anonymous cannot delete the workspace", async () => {
    await expect(t.asUser(null, `SELECT formos.delete_workspace($1)`, [U.wsA])).rejects.toThrow(
      /authentication required/,
    );
  });

  it("failed attempts leave the workspace fully intact (atomicity witness)", async () => {
    const before = new Map<string, number>();
    for (const table of ["workspaces", ...CHILD_TABLES]) {
      before.set(table, await countWs(t, table, U.wsA));
    }
    expect(before.get("form_versions")).toBe(1);
    await expect(t.asUser(U.bob, `SELECT formos.delete_workspace($1)`, [U.wsA])).rejects.toThrow(/owner/);
    await expect(t.asUser(U.mallory, `SELECT formos.delete_workspace($1)`, [U.wsA])).rejects.toThrow(/owner/);
    await expect(t.asUser(null, `SELECT public.delete_workspace($1)`, [U.wsA])).rejects.toThrow(
      /authentication required/,
    );
    for (const table of ["workspaces", ...CHILD_TABLES]) {
      expect(await countWs(t, table, U.wsA)).toBe(before.get(table));
    }
  });
});
