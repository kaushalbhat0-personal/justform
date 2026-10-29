import { beforeEach, describe, expect, it } from "vitest";
import { newTenantDb, uuid, type TenantDb } from "./setup.js";

/**
 * Phase 10 — metering-only billing foundation (PGlite).
 * Proves under least-privilege roles: deterministic periods, idempotent
 * usage events, the single quota boundary (allow/deny/unlimited/fallback),
 * state-based form counting, member floors for summary vs member probe,
 * and the privilege lockdown (no browser writes, column-locked workspaces).
 * Live Supabase re-proves the same contract through real roles + PostgREST.
 */

const U = {
  alice: uuid(71), // owner wsA
  bob: uuid(72), // builder wsA
  dave: uuid(74), // viewer wsA
  mallory: uuid(75), // owner wsB (outsider)
  wsA: uuid(76),
  wsB: uuid(77),
  mAliceA: uuid(78),
  mMalloryB: uuid(79),
};

async function fixture(t: TenantDb): Promise<void> {
  await t.asUser(U.alice, `SELECT formos.create_workspace($1, $2, 'Acme', 'acme-billing')`, [U.wsA, U.mAliceA]);
  await t.asUser(U.mallory, `SELECT formos.create_workspace($1, $2, 'Other', 'other-billing')`, [U.wsB, U.mMalloryB]);
  await t.asSuperuser(`INSERT INTO public.memberships (id, workspace_id, user_id, role) VALUES ($1,$2,$3,'builder'), ($4,$2,$5,'viewer')`, [
    uuid(68), U.wsA, U.bob, uuid(69), U.dave,
  ]);
}

describe("Phase 10: deterministic billing periods", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  const period = (anchor: string | null, now: string) =>
    anchor === null
      ? t.asSuperuser(`SELECT formos.period_start(NULL::timestamptz, $1::timestamptz) AS p`, [now])
      : t.asSuperuser(`SELECT formos.period_start($1::timestamptz, $2::timestamptz) AS p`, [anchor, now]);

  const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

  it("null anchor means calendar months", async () => {
    expect(day((((await period(null, "2026-10-29T12:00:00Z"))[0] as { p: unknown }).p))).toBe("2026-10-01");
    expect(day((((await period(null, "2026-01-01T00:00:00Z"))[0] as { p: unknown }).p))).toBe("2026-01-01");
  });

  it("anchors shift to monthly anniversaries", async () => {
    expect(day((((await period("2026-08-15T00:00:00Z", "2026-10-29T12:00:00Z"))[0] as { p: unknown }).p))).toBe("2026-10-15");
    expect(day((((await period("2026-08-15T00:00:00Z", "2026-10-14T23:59:59Z"))[0] as { p: unknown }).p))).toBe("2026-09-15");
  });

  it("month-end anchors clamp instead of skipping", async () => {
    expect(day((((await period("2026-01-31T00:00:00Z", "2026-03-15T00:00:00Z"))[0] as { p: unknown }).p))).toBe("2026-02-28");
  });

  it("future anchors return the anchor day", async () => {
    expect(day((((await period("2026-12-01T00:00:00Z", "2026-10-29T00:00:00Z"))[0] as { p: unknown }).p))).toBe("2026-12-01");
  });
});

describe("Phase 10: idempotent usage events", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  const record = (sourceId: string, occurredAt?: string) =>
    t.asSuperuser(
      `SELECT formos.record_usage($1, 'submission', 'intake', $2, 1${occurredAt ? ", $3::timestamptz" : ""}) AS r`,
      occurredAt ? [U.wsA, sourceId, occurredAt] : [U.wsA, sourceId],
    );

  it("first write counts, replay does not", async () => {
    const first = (await record("evt-1"))[0] as { r: { counted: boolean } };
    expect(first.r.counted).toBe(true);
    const replay = (await record("evt-1"))[0] as { r: { counted: boolean } };
    expect(replay.r.counted).toBe(false);
    const other = (await record("evt-2"))[0] as { r: { counted: boolean } };
    expect(other.r.counted).toBe(true);
  });

  it("backdated occurrences land in their own period", async () => {
    await record("evt-cur");
    await record("evt-old", "2026-08-10T00:00:00Z");
    const rows = (await t.asSuperuser(
      `SELECT period_start::text AS p, count(*)::int AS n FROM public.usage_events WHERE workspace_id = $1 GROUP BY 1 ORDER BY 1`,
      [U.wsA],
    )) as Array<{ p: string; n: number }>;
    expect(rows).toEqual([
      { p: "2026-08-01", n: 1 },
      { p: expect.stringMatching(/^2026-/) as unknown as string, n: 1 },
    ]);
    expect(rows[1]?.p).not.toBe("2026-08-01");
  });

  it("unknown metrics, sources, and bad ids fail closed", async () => {
    await expect(t.asSuperuser(`SELECT formos.record_usage($1, 'clicks', 'intake', 'x', 1)`, [U.wsA])).rejects.toThrow(/unknown metric/);
    await expect(t.asSuperuser(`SELECT formos.record_usage($1, 'submission', 'browser', 'x', 1)`, [U.wsA])).rejects.toThrow(/unknown source/);
    await expect(t.asSuperuser(`SELECT formos.record_usage($1, 'submission', 'intake', '', 1)`, [U.wsA])).rejects.toThrow(/invalid source id/);
    await expect(t.asSuperuser(`SELECT formos.record_usage($1, 'submission', 'intake', 'x', 0)`, [U.wsA])).rejects.toThrow(/invalid quantity/);
  });
});

describe("Phase 10: single quota boundary", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  const quota = (metric: string, qty = 1) =>
    t.asSuperuser(`SELECT formos.check_quota($1, $2, $3) AS q`, [U.wsA, metric, qty]);

  it("allows under quota with remaining, denies over with zero remaining", async () => {
    const ok = ((await quota("monthly_submissions", 100))[0] as { q: Record<string, unknown> }).q;
    expect(ok).toMatchObject({ allowed: true, current: 0, limit: 100, remaining: 100, reason: "ok" });
    const no = ((await quota("monthly_submissions", 101))[0] as { q: Record<string, unknown> }).q;
    expect(no).toMatchObject({ allowed: false, current: 0, limit: 100, remaining: 0, reason: "quota_exceeded" });
  });

  it("counts recorded usage against the cap", async () => {
    await t.asSuperuser(`SELECT formos.record_usage($1, 'submission', 'intake', 'evt-a', 2)`, [U.wsA]);
    const q = ((await quota("monthly_submissions", 99))[0] as { q: Record<string, unknown> }).q;
    expect(q).toMatchObject({ allowed: false, current: 2, remaining: 0 });
    const q2 = ((await quota("monthly_submissions", 98))[0] as { q: Record<string, unknown> }).q;
    expect(q2).toMatchObject({ allowed: true, remaining: 98 });
  });

  it("unlimited plans never deny", async () => {
    await t.asSuperuser(`UPDATE public.workspaces SET plan = 'business' WHERE id = $1`, [U.wsA]);
    const q = ((await quota("monthly_submissions", 1000000))[0] as { q: Record<string, unknown> }).q;
    expect(q).toMatchObject({ allowed: true, limit: null, remaining: null });
  });

  it("unknown plans fall back to free limits", async () => {
    await t.asSuperuser(`UPDATE public.workspaces SET plan = 'legacy-grandfathered' WHERE id = $1`, [U.wsA]);
    const q = ((await quota("active_forms", 6))[0] as { q: Record<string, unknown> }).q;
    expect(q).toMatchObject({ allowed: false, limit: 5 });
  });

  it("storage is unmetered but allowed", async () => {
    const q = ((await quota("storage_bytes", 1))[0] as { q: Record<string, unknown> }).q;
    expect(q).toMatchObject({ allowed: true, current: null, limit: null, reason: "unmetered" });
  });

  it("active forms are state-based and enforced", async () => {
    for (let i = 0; i < 5; i += 1) {
      await t.asUser(U.alice, `INSERT INTO public.forms (id, workspace_id, key, title, draft_payload, created_by, updated_by) VALUES ($1,$2,$3,'T','{}'::jsonb,$4,$4)`, [
        uuid(80 + i), U.wsA, `f${i}`, U.alice,
      ]);
    }
    const ok = ((await quota("active_forms", 1))[0] as { q: Record<string, unknown> }).q;
    expect(ok).toMatchObject({ allowed: false, current: 5, limit: 5 });
    // Archived forms do not consume the quota.
    await t.asSuperuser(`UPDATE public.forms SET status = 'archived' WHERE workspace_id = $1 AND key = 'f0'`, [U.wsA]);
    const ok2 = ((await quota("active_forms", 1))[0] as { q: Record<string, unknown> }).q;
    expect(ok2).toMatchObject({ allowed: true, current: 4, remaining: 1 });
  });

  it("member probe enforces auth, not the data path", async () => {
    await expect(t.asUser(null, `SELECT formos.check_quota_member($1, 'monthly_submissions', 1)`, [U.wsA])).rejects.toThrow(/authentication required/);
    await expect(t.asUser(U.mallory, `SELECT formos.check_quota_member($1, 'monthly_submissions', 1)`, [U.wsA])).rejects.toThrow(/forbidden/);
    const viewer = ((await t.asUser(U.dave, `SELECT formos.check_quota_member($1, 'monthly_submissions', 1) AS q`, [U.wsA]))[0] as { q: { allowed: boolean } }).q;
    expect(viewer.allowed).toBe(true);
  });
});

describe("Phase 10: usage summary + privilege lockdown", () => {
  let t: TenantDb;
  beforeEach(async () => {
    t = await newTenantDb();
    await fixture(t);
  }, 60000);

  it("summary is admin-floor with plan, period, and per-metric meters", async () => {
    await expect(t.asUser(null, `SELECT formos.get_usage_summary($1)`, [U.wsA])).rejects.toThrow();
    await expect(t.asUser(U.dave, `SELECT formos.get_usage_summary($1)`, [U.wsA])).rejects.toThrow(/forbidden/);
    await expect(t.asUser(U.bob, `SELECT formos.get_usage_summary($1)`, [U.wsA])).rejects.toThrow(/forbidden/);
    await expect(t.asUser(U.mallory, `SELECT formos.get_usage_summary($1)`, [U.wsA])).rejects.toThrow(/forbidden|not found/);
    await t.asSuperuser(`SELECT formos.record_usage($1, 'submission', 'intake', 'evt-s1', 3)`, [U.wsA]);
    const s = ((await t.asUser(U.alice, `SELECT formos.get_usage_summary($1) AS s`, [U.wsA]))[0] as { s: Record<string, unknown> }).s as {
      plan: string; period_start: string; period_end: string; metrics: Record<string, { used: number | null; limit: number | null; remaining: number | null }>;
    };
    expect(s.plan).toBe("free");
    expect(s.period_start).toMatch(/^\d{4}-\d{2}-01$/);
    expect(s.metrics.monthly_submissions).toMatchObject({ used: 3, limit: 100, remaining: 97 });
    expect(s.metrics.active_forms).toMatchObject({ used: 0, limit: 5, remaining: 5 });
    expect(s.metrics.storage_bytes).toMatchObject({ used: null, limit: null, remaining: null });
  });

  it("browser roles hold zero metering privileges; plan columns are not writable", async () => {
    for (const tbl of ["usage_events", "plan_limits"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        for (const role of ["anon", "authenticated"]) {
          const rows = await t.asSuperuser(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `public.${tbl}`, priv]);
          expect((rows[0] as { ok: boolean }).ok).toBe(false);
        }
      }
    }
    // Column lockdown: name/slug stay writable, plan/billing columns do not.
    const nameOk = await t.asSuperuser(`SELECT has_column_privilege('authenticated', 'public.workspaces', 'name', 'UPDATE') AS ok`);
    expect((nameOk[0] as { ok: boolean }).ok).toBe(true);
    for (const col of ["plan", "billing_period_start", "billing_status"]) {
      const rows = await t.asSuperuser(`SELECT has_column_privilege('authenticated', 'public.workspaces', $1, 'UPDATE') AS ok`, [col]);
      expect((rows[0] as { ok: boolean }).ok).toBe(false);
    }
    await expect(t.asUser(U.alice, `UPDATE public.workspaces SET plan = 'business' WHERE id = $1`, [U.wsA])).rejects.toThrow();
    await t.asUser(U.alice, `UPDATE public.workspaces SET name = 'Acme 2' WHERE id = $1`, [U.wsA]);
  });
});
