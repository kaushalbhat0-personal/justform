import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Phase 7 — submission inbox foundation (PGlite).
 * Proves under least-privilege roles: member reads (builder+ only, per frozen
 * matrix), RPC-only status mutation (data_collaborator floor), RLS isolation,
 * pinned-version resolution, and the privilege lockdown (no DML grants).
 * Live Supabase re-proves the same contract through real roles + PostgREST.
 */

const U = {
  alice: uuid(201), // owner wsA
  bob: uuid(202), // builder wsA
  carol: uuid(203), // data_collaborator wsA
  dave: uuid(204), // viewer wsA
  mallory: uuid(205), // owner wsB (outsider)
  wsA: uuid(210),
  wsB: uuid(220),
  mAliceA: uuid(211),
  mMalloryB: uuid(221),
  formA: uuid(230),
  verA1: uuid(231),
  verA2: uuid(232),
  pubA: uuid(233),
  sub1: uuid(240),
  sub2: uuid(241),
  sub3: uuid(242),
};

const docV1 = {
  id: U.formA,
  key: "contact",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Contact" },
  settings: {},
  pages: [
    {
      id: uuid(250),
      key: "main",
      sections: [
        {
          id: uuid(251),
          key: "s",
          fields: [
            { id: uuid(252), key: "name", type: "short_text", label: "Full name", required: true },
            { id: uuid(253), key: "topic", type: "dropdown", label: "Topic", required: false, config: { options: [{ value: "support", label: "Support" }, { value: "sales", label: "Sales" }] } },
          ],
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

// v2 renames the name label and adds an email field — historical rows must
// still resolve through v1.
const docV2 = {
  ...docV1,
  metadata: { title: "Contact" },
  pages: [
    {
      id: uuid(250),
      key: "main",
      sections: [
        {
          id: uuid(251),
          key: "s",
          fields: [
            { id: uuid(252), key: "name", type: "short_text", label: "Your full name", required: true },
            { id: uuid(253), key: "topic", type: "dropdown", label: "Topic", required: false, config: { options: [{ value: "support", label: "Support" }, { value: "sales", label: "Sales" }] } },
            { id: uuid(254), key: "email", type: "email", label: "Email", required: false },
          ],
        },
      ],
    },
  ],
};

async function fixture(t: TenantDb): Promise<void> {
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme-inbox')`, [U.wsA, U.mAliceA]);
  await t.asUser(U.mallory, `SELECT formos.create_workspace($1, $2, 'Other', 'other-inbox')`, [U.wsB, U.mMalloryB]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES
     ($1,$2,$3,'builder'), ($4,$2,$5,'data_collaborator'), ($6,$2,$7,'viewer')`,
    [uuid(212), U.wsA, U.bob, uuid(213), U.carol, uuid(214), U.dave],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by)
     VALUES ($1,$2,'contact','Contact',$3::jsonb,$4,$4)`,
    [U.formA, U.wsA, JSON.stringify(docV1), U.alice],
  );
  await t.asSuperuser(
    `INSERT INTO public.form_versions (id, form_id, workspace_id, published_version_no, schema_snapshot, schema_version, schema_hash, renderer_version, publisher_id)
     VALUES ($1,$2,$3,1,$4::jsonb,1,'hash-v1','r',$5),
            ($6,$2,$3,2,$7::jsonb,1,'hash-v2','r',$5)`,
    [U.verA1, U.formA, U.wsA, JSON.stringify(docV1), U.alice, U.verA2, JSON.stringify(docV2)],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.form_publications (id, workspace_id, form_id, form_version_id, public_id, created_by)
     VALUES ($1,$2,$3,$4,'inbox-pub-id-00000001',$5)`,
    [U.pubA, U.wsA, U.formA, U.verA2, U.alice],
  );
  // sub1/sub2 pinned to v1, sub3 pinned to v2.
  await t.asSuperuser(
    `INSERT INTO public.submissions (id, workspace_id, form_id, publication_id, form_version_id, payload, idempotency_key, submitted_at)
     VALUES ($1,$2,$3,$4,$5,'{"name":"Ann","topic":"support"}'::jsonb,'key-inbox-01','2026-10-20T10:00:00Z'),
            ($6,$2,$3,$4,$5,'{"name":"Bo","topic":"sales"}'::jsonb,'key-inbox-02','2026-10-21T10:00:00Z'),
            ($7,$2,$3,$4,$8,'{"name":"Cy","topic":"support","email":"cy@example.test"}'::jsonb,'key-inbox-03','2026-10-22T10:00:00Z')`,
    [U.sub1, U.wsA, U.formA, U.pubA, U.verA1, U.sub2, U.sub3, U.verA2],
  );
}

const listIds = (t: TenantDb, user: string) =>
  t.asUser(user, `SELECT id FROM public.submissions WHERE workspace_id = $1 ORDER BY submitted_at DESC, id DESC`, [U.wsA]);

describe("Phase 7: member reads (builder+ per frozen matrix)", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("owner/admin/builder list and read; weaker roles and outsiders get zero rows", async () => {
    for (const user of [U.alice, U.bob]) {
      const rows = await listIds(t, user);
      expect(rows.map((r) => (r as { id: string }).id)).toEqual([U.sub3, U.sub2, U.sub1]);
      const one = await t.asUser(user, `SELECT id, payload, status FROM public.submissions WHERE id = $1`, [U.sub1]);
      expect(one).toHaveLength(1);
      expect((one[0] as { status: string }).status).toBe("new");
    }
    for (const user of [U.carol, U.dave, U.mallory]) {
      expect(await listIds(t, user)).toEqual([]);
      expect(await t.asUser(user, `SELECT id FROM public.submissions WHERE id = $1`, [U.sub1])).toEqual([]);
    }
    // Anonymous: no session → zero rows (and zero grants, proven below).
    expect(await t.asUser(null, `SELECT id FROM public.submissions`, [])).toEqual([]);
  });

  it("anon/authenticated hold zero DML privileges on submissions", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = await t.asSuperuser(`SELECT has_table_privilege($1, 'public.submissions', $2) AS ok`, [role, priv]);
        expect((rows[0] as { ok: boolean }).ok).toBe(false);
      }
    }
    const sel = await t.asSuperuser(`SELECT has_table_privilege('authenticated', 'public.submissions', 'SELECT') AS ok`);
    expect((sel[0] as { ok: boolean }).ok).toBe(true);
    const anonSel = await t.asSuperuser(`SELECT has_table_privilege('anon', 'public.submissions', 'SELECT') AS ok`);
    expect((anonSel[0] as { ok: boolean }).ok).toBe(false);
  });

  it("direct writes stay denied for every app role (RPC-only)", async () => {
    for (const user of [U.alice, U.bob, U.carol]) {
      await expect(
        t.asUser(user, `INSERT INTO public.submissions (id, workspace_id, form_id, publication_id, form_version_id, payload, idempotency_key) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,'key-nope-001')`, [uuid(245), U.wsA, U.formA, U.pubA, U.verA1]),
      ).rejects.toThrow();
      await expect(
        t.asUser(user, `UPDATE public.submissions SET status = 'read' WHERE id = $1`, [U.sub1]),
      ).rejects.toThrow();
      await expect(t.asUser(user, `DELETE FROM public.submissions WHERE id = $1`, [U.sub1])).rejects.toThrow();
    }
  });
});

describe("Phase 7: status lifecycle RPC (update floor = data_collaborator)", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  const setStatus = (user: string | null, id: string, status: string) =>
    t.asUser(user, `SELECT formos.set_submission_status($1, $2, NULL) AS r`, [id, status]);

  it("owner/builder/data_collaborator transition; viewer/stranger/anon denied", async () => {
    for (const user of [U.alice, U.bob, U.carol]) {
      const rows = await setStatus(user, U.sub1, "read");
      expect((rows[0] as { r: { status: string; previous: string; changed: boolean } }).r).toMatchObject({ status: "read", previous: "new", changed: true });
      const back = await setStatus(user, U.sub1, "new");
      expect((back[0] as { r: { changed: boolean } }).r.changed).toBe(true);
    }
    await expect(setStatus(U.dave, U.sub1, "read")).rejects.toThrow(/forbidden/);
    await expect(setStatus(U.mallory, U.sub1, "read")).rejects.toThrow(/forbidden/);
    await expect(setStatus(null, U.sub1, "read")).rejects.toThrow(/authentication required/);
  });

  it("archive is a status change, not a deletion", async () => {
    const rows = await setStatus(U.alice, U.sub1, "archived");
    expect((rows[0] as { r: { status: string } }).r.status).toBe("archived");
    const stillThere = await t.asUser(U.alice, `SELECT id FROM public.submissions WHERE id = $1`, [U.sub1]);
    expect(stillThere).toHaveLength(1);
  });

  it("idempotent no-op returns changed=false; invalid status and unknown id rejected", async () => {
    const rows = await setStatus(U.alice, U.sub1, "new");
    expect((rows[0] as { r: { changed: boolean } }).r.changed).toBe(false);
    await expect(setStatus(U.alice, U.sub1, "deleted")).rejects.toThrow(/invalid status/);
    await expect(setStatus(U.alice, uuid(249), "read")).rejects.toThrow(/not found/);
  });

  it("status RPC is member-only (no anon EXECUTE)", async () => {
    const rows = await t.asSuperuser(
      `SELECT has_function_privilege('anon', 'formos.set_submission_status(uuid,text,uuid)', 'EXECUTE') AS ok`,
    );
    expect((rows[0] as { ok: boolean }).ok).toBe(false);
    const auth = await t.asSuperuser(
      `SELECT has_function_privilege('authenticated', 'formos.set_submission_status(uuid,text,uuid)', 'EXECUTE') AS ok`,
    );
    expect((auth[0] as { ok: boolean }).ok).toBe(true);
  });
});

describe("Phase 7: pinned-version resolution", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("each submission resolves through its own pinned snapshot, not the latest", async () => {
    const rows = await t.asUser(
      U.alice,
      `SELECT s.id, v.published_version_no AS ver, v.schema_snapshot AS snap
       FROM public.submissions s JOIN public.form_versions v ON v.id = s.form_version_id
       WHERE s.workspace_id = $1 ORDER BY s.submitted_at`,
      [U.wsA],
    );
    expect(rows.map((r) => (r as { ver: number }).ver)).toEqual([1, 1, 2]);
    const v1 = (rows[0] as { snap: { pages: Array<{ sections: Array<{ fields: Array<{ key: string; label: string }> }> }> } }).snap;
    const v1Name = v1.pages[0]?.sections[0]?.fields.find((f) => f.key === "name");
    expect(v1Name?.label).toBe("Full name");
    expect(v1.pages[0]?.sections[0]?.fields.some((f) => f.key === "email")).toBe(false);
    const v2 = (rows[2] as { snap: { pages: Array<{ sections: Array<{ fields: Array<{ key: string; label: string }> }> }> } }).snap;
    expect(v2.pages[0]?.sections[0]?.fields.find((f) => f.key === "name")?.label).toBe("Your full name");
  });
});
