import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Phase 4 — form persistence lifecycle (PGlite: real Postgres semantics).
 * Proves under the least-privilege app role: draft CRUD + OCC shape,
 * role-gated writes, cross-workspace denial, publish numbering, published
 * immutability (trigger + no policies), slug scoping, audit writes.
 * Canonical-shape validation lives server-side (forms-engine + server
 * actions); the database owns tenancy, roles, concurrency, and immutability.
 */

const U = {
  alice: uuid(1),
  bob: uuid(2),
  carol: uuid(3),
  dave: uuid(4),
  eve: uuid(6),
  stranger: uuid(5),
  wsA: uuid(10),
  wsB: uuid(20),
  mAliceA: uuid(11),
  mDaveB: uuid(21),
  formA: uuid(30),
  formB: uuid(31),
};

const doc = (id: string, key: string): string =>
  JSON.stringify({
    id,
    key,
    schemaVersion: 1,
    rendererVersion: "rjsf-6.11+drv1",
    metadata: { title: "T" },
    settings: {},
    pages: [
      {
        id: uuid(40),
        key: "main",
        sections: [
          {
            id: uuid(41),
            key: "s",
            fields: [{ id: uuid(42), key: "name", type: "short_text", label: "Name", required: true }],
          },
        ],
      },
    ],
    rules: [],
    calculations: [],
    localization: {},
    notificationsRef: null,
    integrationsRef: null,
  });

async function fixture(t: TenantDb): Promise<void> {
  // Alice owns wsA; Bob is builder, Carol viewer, Eve data_collaborator in wsA; Dave owns wsB.
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme')`, [U.wsA, U.mAliceA]);
  await t.asUser(U.dave, `SELECT formos.create_workspace($1, $2, 'Beta', 'beta')`, [U.wsB, U.mDaveB]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES
     ($1,$2,$3,'builder'), ($4,$2,$5,'viewer'), ($6,$2,$7,'data_collaborator')`,
    [uuid(12), U.wsA, U.bob, uuid(13), U.carol, uuid(14), U.eve],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by)
     VALUES ($1,$2,'intake','Intake',$3::jsonb,$4,$4)`,
    [U.formA, U.wsA, doc(U.formA, "intake"), U.alice],
  );
}

describe("Phase 4: draft CRUD + optimistic concurrency", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("owner creates drafts; revision starts at 1 and increases monotonically", async () => {
    const rows = (await t.asUser(U.alice, `SELECT draft_revision, schema_version FROM public.forms WHERE id=$1`, [
      U.formA,
    ])) as Array<{ draft_revision: number; schema_version: number }>;
    expect(rows[0]?.draft_revision).toBe(1);
    expect(rows[0]?.schema_version).toBe(1);
    for (let rev = 1; rev <= 3; rev += 1) {
      const updated = (await t.asUser(
        U.alice,
        `UPDATE public.forms SET title='T'||$1::text, draft_revision=$1::int+1 WHERE id=$2 AND draft_revision=$1::int RETURNING draft_revision`,
        [rev, U.formA],
      )) as Array<{ draft_revision: number }>;
      expect(updated.map((r) => r.draft_revision)).toEqual([rev + 1]);
    }
  });

  it("stale expected revision updates zero rows (conflict shape, no last-write-wins)", async () => {
    const stale = (await t.asUser(
      U.alice,
      `UPDATE public.forms SET title='stale' WHERE id=$1 AND draft_revision=99 RETURNING id`,
      [U.formA],
    )) as unknown[];
    expect(stale).toEqual([]);
    const current = (await t.asUser(U.alice, `SELECT title, draft_revision FROM public.forms WHERE id=$1`, [
      U.formA,
    ])) as Array<{ title: string; draft_revision: number }>;
    expect(current[0]).toMatchObject({ title: "Intake", draft_revision: 1 });
  });

  it("slug uniqueness is scoped per workspace", async () => {
    await expect(
      t.asUser(
        U.alice,
        `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'intake','Dup','{}')`,
        [U.formB, U.wsA],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    await t.asUser(
      U.dave,
      `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'intake','Other','{}')`,
      [U.formB, U.wsB],
    );
    const rows = (await t.asUser(U.dave, `SELECT key FROM public.forms WHERE id=$1`, [U.formB])) as Array<{
      key: string;
    }>;
    expect(rows[0]?.key).toBe("intake");
  });

  it("stored draft payload round-trips exactly (snapshot self-containment base)", async () => {
    const rows = (await t.asUser(U.alice, `SELECT draft_payload FROM public.forms WHERE id=$1`, [U.formA])) as Array<{
      draft_payload: unknown;
    }>;
    expect(rows[0]?.draft_payload).toEqual(JSON.parse(doc(U.formA, "intake")));
  });
});

describe("Phase 4: role + tenant enforcement on forms", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  it("viewer reads but cannot write; data_collaborator gets no builder privileges", async () => {
    const seen = (await t.asUser(U.carol, `SELECT id FROM public.forms`)) as Array<{ id: string }>;
    expect(seen.map((r) => r.id)).toEqual([U.formA]);
    await expect(
      t.asUser(U.carol, `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'x','X','{}')`, [
        uuid(50),
        U.wsA,
      ]),
    ).rejects.toThrow(/row-level security|policy|denied|permission/i);
    const upd = (await t.asUser(U.carol, `UPDATE public.forms SET title='X' WHERE id=$1 RETURNING id`, [U.formA])) as unknown[];
    expect(upd).toEqual([]);
    // DELETE with no permitting policy is a silent deny (RLS shape for UPDATE/DELETE).
    const del = (await t.asUser(U.carol, `DELETE FROM public.forms WHERE id=$1 RETURNING id`, [U.formA])) as unknown[];
    expect(del).toEqual([]);
    await expect(
      t.asUser(U.eve, `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'y','Y','{}')`, [
        uuid(51),
        U.wsA,
      ]),
    ).rejects.toThrow(/row-level security|policy|denied|permission/i);
  });

  it("builder manages drafts; non-member and anonymous get nothing", async () => {
    await t.asUser(
      U.bob,
      `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'bform','B','{}')`,
      [uuid(52), U.wsA],
    );
    const upd = (await t.asUser(U.bob, `UPDATE public.forms SET title='B2' WHERE id=$1 RETURNING id`, [uuid(52)])) as Array<{
      id: string;
    }>;
    expect(upd).toHaveLength(1);
    expect(await t.asUser(U.stranger, `SELECT id FROM public.forms`)).toEqual([]);
    await expect(
      t.asUser(U.stranger, `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload) VALUES ($1,$2,'z','Z','{}')`, [
        uuid(53),
        U.wsA,
      ]),
    ).rejects.toThrow(/row-level security|policy|denied|permission/i);
    expect(await t.asUser(null, `SELECT id FROM public.forms`)).toEqual([]);
  });

  it("cross-workspace access denied even with a known id", async () => {
    expect(await t.asUser(U.dave, `SELECT id FROM public.forms WHERE id=$1`, [U.formA])).toEqual([]);
    const upd = (await t.asUser(U.dave, `UPDATE public.forms SET title='X' WHERE id=$1 RETURNING id`, [U.formA])) as unknown[];
    expect(upd).toEqual([]);
  });

  it("workspace_id is immutable (WITH CHECK errors; trigger backstops privileged writers)", async () => {
    // USING passes on the old row but WITH CHECK fails on the moved row:
    // fail-closed ERROR (not a silent bypass).
    await expect(
      t.asUser(U.alice, `UPDATE public.forms SET workspace_id=$1 WHERE id=$2 RETURNING id`, [U.wsB, U.formA]),
    ).rejects.toThrow(/immutable|row-level security/i);
    // Privileged writers bypass RLS but still hit the trigger.
    await expect(t.asSuperuser(`UPDATE public.forms SET workspace_id=$1 WHERE id=$2`, [U.wsB, U.formA])).rejects.toThrow(
      /immutable/,
    );
    const kept = (await t.asUser(U.alice, `SELECT workspace_id FROM public.forms WHERE id=$1`, [U.formA])) as Array<{
      workspace_id: string;
    }>;
    expect(kept[0]?.workspace_id).toBe(U.wsA);
  });
});

describe("Phase 4: publish numbering + published immutability", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 30000);

  let versionSeq = 60;
  const publish = (user: string | null, form: string, rev: number) => {
    versionSeq += 1;
    return t.asUser(user, `SELECT public.publish_form($1,$2,$3::jsonb,1,'h','rjsf-6.11+drv1',$4,$5) AS v`, [
      uuid(versionSeq),
      form,
      doc(form, "intake"),
      user,
      rev,
    ]) as Promise<Array<{ v: number }>>;
  };

  it("publishes sequential versions; stale revision conflicts; unauthorized callers denied", async () => {
    expect((await publish(U.alice, U.formA, 1))[0]?.v).toBe(1);
    expect((await publish(U.alice, U.formA, 1))[0]?.v).toBe(2);
    await expect(publish(U.alice, U.formA, 99)).rejects.toThrow(/draft conflict/);
    await expect(publish(U.carol, U.formA, 1)).rejects.toThrow(/builder required/);
    await expect(publish(U.stranger, U.formA, 1)).rejects.toThrow(/not a member|builder required|authentication/);
    await expect(publish(null, U.formA, 1)).rejects.toThrow(/authentication required/);
  });

  it("builder can publish; snapshots are self-contained and version-unique", async () => {
    expect((await publish(U.bob, U.formA, 1))[0]?.v).toBe(1);
    const rows = (await t.asUser(U.carol, `SELECT published_version_no, schema_snapshot, schema_hash FROM public.form_versions WHERE form_id=$1 ORDER BY published_version_no`, [
      U.formA,
    ])) as Array<{ published_version_no: number; schema_snapshot: unknown; schema_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.schema_snapshot).toEqual(JSON.parse(doc(U.formA, "intake")));
    expect(rows[0]?.schema_hash).toBe("h");
    await expect(
      t.asSuperuser(
        `INSERT INTO public.form_versions (id, form_id, workspace_id, published_version_no, schema_snapshot, schema_version, schema_hash, renderer_version)
         VALUES ($1,$2,$3,1,'{}',1,'x','r')`,
        [uuid(70), U.formA, U.wsA],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("published versions are immutable at every layer", async () => {
    await publish(U.alice, U.formA, 1);
    // App role holds no UPDATE/DELETE grant at all: privilege-denied first.
    await expect(t.asUser(U.alice, `UPDATE public.form_versions SET schema_hash='x' WHERE form_id=$1`, [U.formA])).rejects.toThrow(
      /permission denied/,
    );
    await expect(t.asUser(U.alice, `DELETE FROM public.form_versions WHERE form_id=$1`, [U.formA])).rejects.toThrow(
      /permission denied/,
    );
    // Privileged writers bypass RLS/grants but still hit the trigger.
    await expect(t.asSuperuser(`UPDATE public.form_versions SET schema_hash='x' WHERE form_id=$1`, [U.formA])).rejects.toThrow(
      /immutable/,
    );
    await expect(t.asSuperuser(`DELETE FROM public.form_versions WHERE form_id=$1`, [U.formA])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      t.asUser(
        U.alice,
        `INSERT INTO public.form_versions (id, form_id, workspace_id, published_version_no, schema_snapshot, schema_version, schema_hash, renderer_version)
         VALUES ($1,$2,$3,9,'{}',1,'x','r')`,
        [uuid(71), U.formA, U.wsA],
      ),
    ).rejects.toThrow(/row-level security|policy|denied|permission/i);
    // Non-members read nothing from the version history.
    expect(await t.asUser(U.stranger, `SELECT id FROM public.form_versions WHERE form_id=$1`, [U.formA])).toEqual([]);
  });

  it("form lifecycle audit events are member-writable and non-member-denied", async () => {
    await t.asUser(
      U.alice,
      `INSERT INTO public.audit_log (id, workspace_id, actor_id, action, resource_type, resource_id)
       VALUES ($1,$2,$3,'form.created','form',$4)`,
      [uuid(80), U.wsA, U.alice, U.formA],
    );
    const rows = (await t.asUser(U.alice, `SELECT action FROM public.audit_log WHERE resource_id=$1`, [U.formA])) as Array<{
      action: string;
    }>;
    expect(rows.map((r) => r.action)).toEqual(["form.created"]);
    await expect(
      t.asUser(
        U.stranger,
        `INSERT INTO public.audit_log (id, workspace_id, actor_id, action, resource_type, resource_id)
         VALUES ($1,$2,$3,'form.created','form',$4)`,
        [uuid(81), U.wsA, U.stranger, U.formA],
      ),
    ).rejects.toThrow(/row-level security|policy|denied|permission/i);
  });
});
