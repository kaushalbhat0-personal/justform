import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Phase 6 — public publication + secure submission intake (PGlite).
 * Proves under least-privilege roles: redacted resolution, availability
 * states, intake invariants (publication/schedule/caps/unique/idempotency/
 * file-gating), submission+outbox atomicity, and the privilege lockdown
 * (RPC-only tables, intake_caller-only EXECUTE, no public wrapper).
 * Live Supabase re-proves the same contract through real roles + PostgREST.
 */

const U = {
  alice: uuid(101),
  bob: uuid(102),
  carol: uuid(103),
  stranger: uuid(104),
  wsA: uuid(110),
  mAliceA: uuid(111),
  formA: uuid(120),
  verA: uuid(121),
  pubA: uuid(122),
};

const FIELD_TEXT = "00000000-0000-4000-8000-000000001301";
const FIELD_FILE = "00000000-0000-4000-8000-000000001302";
const PAGE = "00000000-0000-4000-8000-000000001303";
const SECTION = "00000000-0000-4000-8000-000000001304";

const docA = {
  id: U.formA,
  key: "intake",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Intake" },
  settings: {},
  pages: [
    {
      id: PAGE,
      key: "main",
      sections: [
        {
          id: SECTION,
          key: "s",
          fields: [
            { id: FIELD_TEXT, key: "name", type: "short_text", label: "Name", required: true },
            {
              id: FIELD_FILE,
              key: "docs",
              type: "file",
              label: "Docs",
              required: false,
              validation: { maxMB: 5, mime: ["application/pdf"], maxCount: 2 },
            },
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

async function fixture(t: TenantDb): Promise<void> {
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme-pub')`, [U.wsA, U.mAliceA]);
  await t.asSuperuser(
    `INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'builder'), ($4,$2,$5,'viewer')`,
    [uuid(112), U.wsA, U.bob, uuid(113), U.carol],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by)
     VALUES ($1,$2,'intake','Intake',$3::jsonb,$4,$4)`,
    [U.formA, U.wsA, JSON.stringify(docA), U.alice],
  );
  // Versions are RPC-minted in prod (no direct-write policies); the fixture
  // seeds through the table owner exactly as publish_form would.
  await t.asSuperuser(
    `INSERT INTO public.form_versions (id, form_id, workspace_id, published_version_no, schema_snapshot, schema_version, schema_hash, renderer_version, publisher_id)
     VALUES ($1,$2,$3,1,$4::jsonb,1,'hash-a','rjsf-6.11+drv1',$5)`,
    [U.verA, U.formA, U.wsA, JSON.stringify(docA), U.alice],
  );
  await t.asUser(
    U.alice,
    `INSERT INTO public.form_publications (id, workspace_id, form_id, form_version_id, public_id, created_by)
     VALUES ($1,$2,$3,$4,'pubA-public-id-22chars',$5)`,
    [U.pubA, U.wsA, U.formA, U.verA, U.alice],
  );
}

const resolve = (t: TenantDb, user: string | null, publicId: string) =>
  t.asUser(user, `SELECT formos.resolve_public_form($1) AS row`, [publicId]);

const submit = (
  t: TenantDb,
  publicId: string,
  submissionId: string,
  payload: unknown,
  key: string,
) =>
  // Logic runs as table owner (exactly how the DEFINER body executes in
  // prod); the privilege path is proven separately below + live as
  // intake_caller. Least-privilege app roles hold no EXECUTE grant.
  t.asSuperuser(`SELECT formos.submit_submission($1,$2,$3::jsonb,$4) AS receipt`, [
    publicId,
    submissionId,
    JSON.stringify(payload),
    key,
  ]);

describe("Phase 6: public resolution", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("valid public id resolves the pinned snapshot with no internal identifiers", async () => {
    const rows = await resolve(t, null, "pubA-public-id-22chars");
    const row = (rows[0] as { row: Record<string, unknown> }).row;
    expect(row["available"]).toBe(true);
    expect(row["public_id"]).toBe("pubA-public-id-22chars");
    expect(row["title"]).toBe("Intake");
    expect(row["published_version_no"]).toBe(1);
    expect((row["schema_snapshot"] as { key: string }).key).toBe("intake");
    expect("workspace_id" in row).toBe(false);
    expect("workspaceId" in row).toBe(false);
    expect("draft" in row).toBe(false);
  });

  it("unknown and malformed identifiers raise a uniform miss", async () => {
    await expect(resolve(t, null, "does-not-exist-00000000")).rejects.toThrow(/not available/);
    await expect(resolve(t, null, "nope!bad chars")).rejects.toThrow(/not available/);
  });

  it("inactive publication and archived form are closed, never the draft", async () => {
    await t.asUser(U.alice, `UPDATE public.form_publications SET is_active = false WHERE id = $1`, [U.pubA]);
    await expect(resolve(t, null, "pubA-public-id-22chars")).rejects.toThrow(/closed/);
    await t.asUser(U.alice, `UPDATE public.form_publications SET is_active = true WHERE id = $1`, [U.pubA]);
    await t.asUser(U.alice, `UPDATE public.forms SET status = 'archived' WHERE id = $1`, [U.formA]);
    await expect(resolve(t, null, "pubA-public-id-22chars")).rejects.toThrow(/closed/);
  });

  it("schedule windows return distinct availability reasons", async () => {
    await t.asUser(
      U.alice,
      `UPDATE public.form_publications SET opens_at = now() + interval '1 hour' WHERE id = $1`,
      [U.pubA],
    );
    const notOpen = (await resolve(t, null, "pubA-public-id-22chars"))[0] as { row: { available: boolean; reason: string } };
    expect(notOpen.row).toMatchObject({ available: false, reason: "not_open" });
    await t.asUser(
      U.alice,
      `UPDATE public.form_publications SET opens_at = now() - interval '2 hours', closes_at = now() - interval '1 hour' WHERE id = $1`,
      [U.pubA],
    );
    const closed = (await resolve(t, null, "pubA-public-id-22chars"))[0] as { row: { available: boolean; reason: string } };
    expect(closed.row).toMatchObject({ available: false, reason: "closed" });
  });

  it("a reached cap reports capped without leaking counts", async () => {
    await t.asUser(U.alice, `UPDATE public.form_publications SET max_submissions = 1 WHERE id = $1`, [U.pubA]);
    await submit(t, "pubA-public-id-22chars", uuid(201), { name: "Ann" }, "key-cap-1");
    const capped = (await resolve(t, null, "pubA-public-id-22chars"))[0] as { row: Record<string, unknown> };
    expect(capped.row).toMatchObject({ available: false, reason: "capped" });
    expect("count" in capped.row && capped.row["count"]).toBeFalsy();
  });

  it("unique(Field) publication rejects a repeated value with distinct keys", async () => {
    await t.asUser(U.alice, `UPDATE public.form_publications SET unique_field_key = 'name' WHERE id = $1`, [U.pubA]);
    await submit(t, "pubA-public-id-22chars", uuid(202), { name: "Bo" }, "key-uniq-1");
    await expect(submit(t, "pubA-public-id-22chars", uuid(203), { name: "Bo" }, "key-uniq-2")).rejects.toThrow(
      /duplicate/,
    );
  });
});

describe("Phase 6: intake transaction", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("valid submission stores the receipt plus an atomic outbox event", async () => {
    const rows = await submit(t, "pubA-public-id-22chars", uuid(210), { name: "Ann" }, "key-ok-1");
    const receipt = (rows[0] as { receipt: { submission_id: string; duplicate: boolean; status: string } }).receipt;
    expect(receipt).toMatchObject({ submission_id: uuid(210), duplicate: false, status: "received" });
    const subs = await t.asSuperuser(`SELECT id, payload, idempotency_key FROM public.submissions WHERE publication_id = $1`, [
      U.pubA,
    ]);
    expect(subs).toHaveLength(1);
    const events = await t.asSuperuser(`SELECT event_type, aggregate_type, aggregate_id, payload FROM public.outbox`);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "submission.completed", aggregate_type: "submission", aggregate_id: uuid(210) });
    // The event carries receipt metadata only — never the respondent payload.
    const payload = (events[0] as { payload: Record<string, unknown> }).payload;
    expect(Object.keys(payload).sort()).toEqual(
      ["form_id", "publication_id", "published_version_no", "received_at", "submission_id"].sort(),
    );
    expect(JSON.stringify(payload)).not.toContain("Ann");
  });

  it("same idempotency key replays the original receipt without a duplicate row", async () => {
    await submit(t, "pubA-public-id-22chars", uuid(211), { name: "Ann" }, "key-replay-1");
    const rows = await submit(t, "pubA-public-id-22chars", uuid(212), { name: "Ann" }, "key-replay-1");
    const receipt = (rows[0] as { receipt: { submission_id: string; duplicate: boolean } }).receipt;
    expect(receipt).toMatchObject({ submission_id: uuid(211), duplicate: true });
    const subs = await t.asSuperuser(`SELECT id FROM public.submissions WHERE publication_id = $1`, [U.pubA]);
    expect(subs).toHaveLength(1);
  });

  it("different keys produce distinct submissions", async () => {
    await submit(t, "pubA-public-id-22chars", uuid(213), { name: "A" }, "key-distinct-a");
    await submit(t, "pubA-public-id-22chars", uuid(214), { name: "B" }, "key-distinct-b");
    const subs = await t.asSuperuser(`SELECT id FROM public.submissions WHERE publication_id = $1`, [U.pubA]);
    expect(subs).toHaveLength(2);
  });

  it("caps roll back atomically: no submission and no outbox event", async () => {
    await t.asUser(U.alice, `UPDATE public.form_publications SET max_submissions = 1 WHERE id = $1`, [U.pubA]);
    await submit(t, "pubA-public-id-22chars", uuid(215), { name: "A" }, "key-cap-a");
    await expect(submit(t, "pubA-public-id-22chars", uuid(216), { name: "B" }, "key-cap-b")).rejects.toThrow(
      /limit reached/,
    );
    const subs = await t.asSuperuser(`SELECT count(*)::int AS n FROM public.submissions`, []);
    const events = await t.asSuperuser(`SELECT count(*)::int AS n FROM public.outbox`, []);
    expect((subs[0] as { n: number }).n).toBe(1);
    expect((events[0] as { n: number }).n).toBe(1);
  });

  it("file refs are gated (pipeline deferred) while empty arrays pass", async () => {
    await expect(
      submit(t, "pubA-public-id-22chars", uuid(217), { name: "A", docs: [uuid(218)] }, "key-file-1"),
    ).rejects.toThrow(/attachments not available/);
    await submit(t, "pubA-public-id-22chars", uuid(219), { name: "A", docs: [] }, "key-file-2");
  });

  it("malformed envelopes are rejected at the database floor", async () => {
    await expect(submit(t, "pubA-public-id-22chars", uuid(220), [1, 2, 3], "key-bad-1")).rejects.toThrow(
      /invalid payload/,
    );
    await expect(submit(t, "pubA-public-id-22chars", uuid(221), { name: "A" }, "short")).rejects.toThrow(
      /invalid payload/,
    );
    await expect(
      submit(t, "pubA-public-id-22chars", uuid(222), { name: "x".repeat(300_000) }, "key-big-1"),
    ).rejects.toThrow(/payload too large/);
  });

  it("unknown/inactive publications reject with no rows written", async () => {
    await expect(submit(t, "missing-public-id-0000", uuid(223), { name: "A" }, "key-miss-1")).rejects.toThrow(
      /not available/,
    );
    await t.asUser(U.alice, `UPDATE public.form_publications SET is_active = false WHERE id = $1`, [U.pubA]);
    await expect(submit(t, "pubA-public-id-22chars", uuid(224), { name: "A" }, "key-closed-1")).rejects.toThrow(
      /closed/,
    );
    const subs = await t.asSuperuser(`SELECT count(*)::int AS n FROM public.submissions`, []);
    const events = await t.asSuperuser(`SELECT count(*)::int AS n FROM public.outbox`, []);
    expect((subs[0] as { n: number }).n).toBe(0);
    expect((events[0] as { n: number }).n).toBe(0);
  });
});

describe("Phase 6: privilege lockdown", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("writes stay RPC-only: zero DML for anon/authenticated; member SELECT only", async () => {
    // Phase 7 deliberately adds GRANT SELECT ON submissions TO authenticated
    // (RLS builder+ member reads). DML stays ungranted everywhere: the intake
    // and status RPCs are the only writers, for every role.
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["submissions", "outbox"]) {
        for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
          const rows = await t.asSuperuser(`SELECT has_table_privilege($1, $2, $3) AS ok`, [
            role,
            `public.${table}`,
            priv,
          ]);
          expect((rows[0] as { ok: boolean }).ok).toBe(false);
        }
      }
    }
    const anonSel = await t.asSuperuser(`SELECT has_table_privilege('anon', 'public.submissions', 'SELECT') AS ok`);
    expect((anonSel[0] as { ok: boolean }).ok).toBe(false);
    const memberSel = await t.asSuperuser(`SELECT has_table_privilege('authenticated', 'public.submissions', 'SELECT') AS ok`);
    expect((memberSel[0] as { ok: boolean }).ok).toBe(true);
  });

  it("anon holds zero grants on form_publications", async () => {
    for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const rows = await t.asSuperuser(`SELECT has_table_privilege('anon', 'public.form_publications', $1) AS ok`, [priv]);
      expect((rows[0] as { ok: boolean }).ok).toBe(false);
    }
  });

  it("resolver is executable by anon/authenticated; intake is intake_caller-only", async () => {
    for (const role of ["anon", "authenticated"]) {
      const okResolve = await t.asSuperuser(
        `SELECT has_function_privilege($1, 'formos.resolve_public_form(text)', 'EXECUTE') AS ok`,
        [role],
      );
      expect((okResolve[0] as { ok: boolean }).ok).toBe(true);
      const noIntake = await t.asSuperuser(
        `SELECT has_function_privilege($1, 'formos.submit_submission(text,uuid,jsonb,text)', 'EXECUTE') AS ok`,
        [role],
      );
      expect((noIntake[0] as { ok: boolean }).ok).toBe(false);
    }
    const intake = await t.asSuperuser(
      `SELECT has_function_privilege('intake_caller', 'formos.submit_submission(text,uuid,jsonb,text)', 'EXECUTE') AS ok`,
    );
    expect((intake[0] as { ok: boolean }).ok).toBe(true);
    const publicWrapper = await t.asSuperuser(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'submit_submission'`,
    );
    expect((publicWrapper[0] as { n: number }).n).toBe(0);
  });

  it("the least-privilege app role cannot invoke the intake function", async () => {
    await expect(
      t.asUser(U.alice, `SELECT formos.submit_submission('x',$1,'{}'::jsonb,'key-denied-01')`, [uuid(230)]),
    ).rejects.toThrow(/permission denied|not available/);
  });

  it("tenant isolation: builder+ read own rows; weaker roles and outbox stay denied", async () => {
    await submit(t, "pubA-public-id-22chars", uuid(231), { name: "Ann" }, "key-iso-1");
    // Phase 7 member reads (RLS builder+ policy): owners/builders see their
    // workspace rows; outbox stays RPC-only for every app role.
    for (const user of [U.alice, U.bob]) {
      const seen = await t.asUser(user, `SELECT id FROM public.submissions`, []);
      expect(seen).toHaveLength(1);
    }
    for (const user of [U.carol, U.stranger]) {
      expect(await t.asUser(user, `SELECT id FROM public.submissions`, [])).toEqual([]);
    }
    for (const user of [U.alice, U.bob, U.carol, U.stranger]) {
      await expect(t.asUser(user, `SELECT id FROM public.outbox`, [])).rejects.toThrow(/permission denied/);
    }
  });

  it("publication management stays builder-gated", async () => {
    // Viewer cannot create; outsider cannot read.
    await expect(
      t.asUser(U.carol, `INSERT INTO public.form_publications (id, workspace_id, form_id, form_version_id, public_id) VALUES ($1,$2,$3,$4,'viewer-made-pub-id-0001')`, [
        uuid(240),
        U.wsA,
        U.formA,
        U.verA,
      ]),
    ).rejects.toThrow();
    const seen = await t.asUser(U.stranger, `SELECT id FROM public.form_publications`, []);
    expect(seen).toHaveLength(0);
    const own = await t.asUser(U.alice, `SELECT id FROM public.form_publications WHERE workspace_id = $1`, [U.wsA]);
    expect(own).toHaveLength(1);
  });
});
