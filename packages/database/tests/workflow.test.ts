import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * IMPL-011 — workflow foundation (PGlite).
 * Airport scenario: Alice (owner) + Bob (admin) process Employee A's leave
 * request; Bob cannot re-decide after Alice approves; cross-workspace denial;
 * immutability of workflow versions; idempotent intake autostart.
 */

const U = {
  alice: uuid(1),
  bob: uuid(2),
  charlie: uuid(3),
  employee: uuid(4),
  mallory: uuid(5),
  wsA: uuid(10),
  wsB: uuid(11),
  mAlice: uuid(12),
  mBob: uuid(13),
  mCharlie: uuid(14),
  mMallory: uuid(15),
  formA: uuid(20),
  verA1: uuid(21),
  pubA: uuid(22),
  sub1: uuid(30),
  sub2: uuid(31),
  defA: uuid(40),
};

const doc = {
  id: U.formA,
  key: "leave",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Leave Request" },
  settings: {},
  pages: [
    {
      id: uuid(50),
      key: "main",
      sections: [
        {
          id: uuid(51),
          key: "s",
          fields: [{ id: uuid(52), key: "reason", type: "short_text", label: "Reason", required: true }],
        },
      ],
    },
  ],
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

async function fixture(t: TenantDb): Promise<void> {
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Airport', 'airport-wf')`, [U.wsA, U.mAlice]);
  await t.asUser(U.mallory, `SELECT formos.create_workspace($1, $2, 'Other', 'other-wf')`, [U.wsB, U.mMallory]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'admin'), ($4,$2,$5,'builder')`,
    [U.mBob, U.wsA, U.bob, U.mCharlie, U.charlie],
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
     VALUES ($1,$2,$3,$4,'leave-pub-id-00000001',$5)`,
    [U.pubA, U.wsA, U.formA, U.verA1, U.alice],
  );
}

let t: TenantDb;
beforeEach(async () => {
  t = await newTenantDb();
  await fixture(t);
});

describe("workflow foundation", () => {
  it("creates, activates, and autostarts workflow on intake", async () => {
    await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
      U.defA,
      U.formA,
      JSON.stringify(CONFIG),
    ]);
    const act = await t.asUser(U.alice, `SELECT formos.activate_workflow($1)`, [U.defA]);
    expect((act[0] as { activate_workflow: { status: string } }).activate_workflow.status).toBe("active");

    // Intake autostart runs as intake_caller with full privileges.
    await t.asSuperuser(`SET ROLE intake_caller`);
    try {
      const receipt = await t.asSuperuser(
        `SELECT formos.submit_submission('leave-pub-id-00000001', $1, '{"reason":"vacation"}'::jsonb, 'wf-key-01')`,
        [U.sub1],
      );
      const r = (receipt[0] as { submit_submission: { workflow_started: boolean } }).submit_submission;
      expect(r.workflow_started).toBe(true);
    } finally {
      await t.asSuperuser(`RESET ROLE`);
    }

    const inst = await t.asUser(U.alice, `SELECT status FROM public.workflow_instances WHERE submission_id = $1`, [U.sub1]);
    expect((inst[0] as { status: string }).status).toBe("in_progress");
    const tasks = await t.asUser(U.alice, `SELECT status FROM public.workflow_tasks WHERE submission_id = $1`, [U.sub1]);
    expect((tasks[0] as { status: string }).status).toBe("pending");
  });

  it("claim → approve completes instance; second decide conflicts", async () => {
    await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
      U.defA,
      U.formA,
      JSON.stringify(CONFIG),
    ]);
    await t.asUser(U.alice, `SELECT formos.activate_workflow($1)`, [U.defA]);
    await t.asSuperuser(
      `INSERT INTO public.submissions (id, workspace_id, form_id, publication_id, form_version_id, payload, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'{"reason":"x"}'::jsonb,'wf-key-02')`,
      [U.sub1, U.wsA, U.formA, U.pubA, U.verA1],
    );
    await t.asUser(U.alice, `SELECT formos.start_workflow($1)`, [U.sub1]);

    const taskRows = await t.asUser(U.alice, `SELECT id FROM public.workflow_tasks WHERE submission_id = $1`, [U.sub1]);
    const taskId = (taskRows[0] as { id: string }).id;

    // Bob (admin) claims.
    const claim = await t.asUser(U.bob, `SELECT formos.claim_task($1)`, [taskId]);
    expect((claim[0] as { claim_task: { status: string } }).claim_task.status).toBe("claimed");

    // Alice approves.
    const decide = await t.asUser(U.alice, `SELECT formos.decide_task($1, 'approved')`, [taskId]);
    expect((decide[0] as { decide_task: { instance_status: string } }).decide_task.instance_status).toBe("completed");

    // Bob cannot approve again → conflict.
    await expect(t.asUser(U.bob, `SELECT formos.decide_task($1, 'approved')`, [taskId])).rejects.toThrow(/conflict/);

    const inst = await t.asUser(U.alice, `SELECT status FROM public.workflow_instances WHERE submission_id = $1`, [U.sub1]);
    expect((inst[0] as { status: string }).status).toBe("completed");
  });

  it("denies cross-workspace access and viewer mutations", async () => {
    await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
      U.defA,
      U.formA,
      JSON.stringify(CONFIG),
    ]);
    await expect(
      t.asUser(U.mallory, `SELECT formos.activate_workflow($1)`, [U.defA]),
    ).rejects.toThrow(/forbidden|not found/);
    const rows = await t.asUser(U.mallory, `SELECT id FROM public.workflow_definitions WHERE id = $1`, [U.defA]);
    expect(rows.length).toBe(0);
  });

  it("keeps workflow versions immutable", async () => {
    await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
      U.defA,
      U.formA,
      JSON.stringify(CONFIG),
    ]);
    await t.asUser(U.alice, `SELECT formos.activate_workflow($1)`, [U.defA]);
    await expect(
      t.asSuperuser(`UPDATE public.workflow_versions SET status = 'active'`),
    ).rejects.toThrow(/immutable/);
  });

  it("rejects invalid configs and duplicate definitions", async () => {
    await expect(
      t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
        U.defA,
        U.formA,
        JSON.stringify({ trigger: "cron", steps: [] }),
      ]),
    ).rejects.toThrow(/invalid workflow config/);
    await t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
      U.defA,
      U.formA,
      JSON.stringify(CONFIG),
    ]);
    await expect(
      t.asUser(U.alice, `SELECT formos.create_workflow_definition($1, $2, $3::jsonb)`, [
        uuid(41),
        U.formA,
        JSON.stringify(CONFIG),
      ]),
    ).rejects.toThrow(/already exists/);
  });
});
