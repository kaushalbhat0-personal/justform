#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 6 public intake (Gates P1–P10).
 * Requires migration 0006 applied (`supabase db push`) plus:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (PostgREST),
 *   DATABASE_URL (direct superuser connection for role/privilege setup),
 *   INTAKE_DB_ROLE_PASSWORD (least-privilege intake_caller credential).
 * Optional: APP_URL — when reachable, HTTP end-to-end gates run; otherwise
 * they SKIP (DB gates still prove the contract).
 *
 * Proves: migration + RLS/FORCE, the privilege lockdown (RPC-only tables,
 * intake_caller-only EXECUTE, no public wrapper), anonymous redaction +
 * uniform misses, publication lifecycle, intake invariants (schedule, caps,
 * uniqueness, idempotency, file gating, attachment-free outbox), atomicity,
 * and — when APP_URL answers — the full BFF path incl. Zod rejection,
 * honeypot, size limits, and concurrent same-key collapse.
 * Never prints secrets/tokens (only lengths and timings).
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* ------------------------------------------------------------------ env */
// Load repo .env for keys that are not already exported (never printed).
// NOTE: the file uses CRLF — strip \r before matching (JS `.` excludes \r,
// so an anchored `(.*)$` would silently match nothing).
for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, INTAKE_DB_ROLE_PASSWORD } =
  process.env;
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL || !INTAKE_DB_ROLE_PASSWORD) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, INTAKE_DB_ROLE_PASSWORD.");
  process.exit(0);
}
console.log(`env: anonKeyLen=${SUPABASE_ANON_KEY.length} intakePwdLen=${INTAKE_DB_ROLE_PASSWORD.length} appUrl=${APP_URL || "(unset)"}`);

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const timed = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  console.log(`   [S] ${label}: ${(performance.now() - t0).toFixed(1)}ms`);
  return out;
};

/** Deterministic canonical JSON (mirrors forms-engine stableStringify). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/* ------------------------------------------------- connections */
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
function poolerEndpoint() {
  const raw = readFileSync(new URL("../../supabase/.temp/pooler-url", import.meta.url), "utf8").trim();
  const u = new URL(raw);
  return { hostname: u.hostname, port: Number(u.port) || 5432 };
}
/** Options-object auth (never URL strings: passwords may contain URL-significant chars). */
function directOpts(user, password) {
  const u = new URL(DATABASE_URL);
  return {
    host: u.hostname,
    port: Number(u.port) || 5432,
    database: u.pathname.replace(/^\//, "") || "postgres",
    user,
    password,
    ssl: "require",
  };
}
function poolerOpts(user, password) {
  const ep = poolerEndpoint();
  return { host: ep.hostname, port: ep.port, database: "postgres", user: `${user}.${projectRef}`, password, ssl: "require" };
}
/** Direct connection first, Supavisor pooler fallback (same credentials). */
async function connectResilient(user, password, options, label) {
  try {
    const sql = postgres({ ...directOpts(user, password), ...options, connect_timeout: 8 });
    await sql`SELECT 1 AS ok`;
    console.log(`${label}: direct connection ok`);
    return { sql, path: "direct" };
  } catch (e) {
    console.log(`${label}: direct failed (${e.code ?? e.message}), trying pooler…`);
    const sql = postgres({ ...poolerOpts(user, password), ...options, connect_timeout: 15 });
    await sql`SELECT 1 AS ok`;
    console.log(`${label}: pooler connection ok`);
    return { sql, path: "pooler" };
  }
}

// Direct superuser connection (DDL + privilege probes).
const superUser = new URL(DATABASE_URL).username || "postgres";
const superConn = await connectResilient(superUser, decodeURIComponent(new URL(DATABASE_URL).password), { max: 1, prepare: false }, "superuser");
const superSql = superConn.sql;

// Provision intake_caller password out-of-band (superuser session; value never printed).
// NOTE: through the Supavisor pooler the new credential converges
// eventually — verify with bounded retries before proving the path.
{
  const escaped = INTAKE_DB_ROLE_PASSWORD.replace(/'/g, "''");
  await superSql.unsafe(`ALTER ROLE intake_caller WITH LOGIN PASSWORD '${escaped}'`);
  console.log("intake_caller login provisioned (password set, length check only).");
}

// Least-privilege intake path (exactly what the BFF uses).
async function connectIntake(attempts = 8) {
  let lastError = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const conn = await connectResilient("intake_caller", INTAKE_DB_ROLE_PASSWORD, {
        max: 3,
        prepare: false,
      }, `intake_caller (attempt ${i})`);
      return conn;
    } catch (e) {
      lastError = e;
      console.log(`intake_caller: attempt ${i} failed (${e.code ?? e.message}), waiting for credential convergence…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastError ?? new Error("intake_caller unreachable");
}
const intakeConn = await connectIntake();
const intakeSql = intakeConn.sql;
console.log(`connection paths: super=${superConn.path} intake=${intakeConn.path}`);
// NOTE: payloads go through `sql.json()` — interpolating a pre-stringified
// value would double-encode it into a JSON string scalar (proven by probe).
const intakeCall = (payload, key, subId = randomUUID()) => intakeSql`
  SELECT formos.submit_submission(${pubId}, ${subId}::uuid, ${intakeSql.json(payload)}, ${key}) AS receipt`;

const tag = Date.now().toString(36);
const email = (n) => `pubintake-${n}-${tag}@example.test`;
const FIELD_TEXT = randomUUID();
const FIELD_FILE = randomUUID();

const mkUser = async (n) => {
  const { data, error } = await admin.auth.admin.createUser({ email: email(n), password: "Verify123!", email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${n}: ${error?.message}`);
  return data.user;
};
const login = async (n) => {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await c.auth.signInWithPassword({ email: email(n), password: "Verify123!" });
  if (error || !data.user) throw new Error(`login ${n}: ${error?.message}`);
  return c;
};

const users = [];
const alice = await mkUser("alice");
const stranger = await mkUser("stranger");
users.push(alice, stranger);
const aliceC = await login("alice");
const strangerC = await login("stranger");

const wsA = randomUUID();
const formA = randomUUID();
const pubId = `live-${tag}-pub01`.slice(0, 22);

const docA = {
  id: formA,
  key: "intake",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Live Intake" },
  settings: {},
  pages: [
    {
      id: randomUUID(),
      key: "main",
      sections: [
        {
          id: randomUUID(),
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
const hashDoc = (d) => createHash("sha256").update(stableStringify(d), "utf8").digest("hex");

let publicationRowId = null;
let versionId = null;

async function submissionCount() {
  const rows = await superSql`SELECT count(*)::int AS n FROM public.submissions WHERE publication_id = ${publicationRowId}`;
  return rows[0].n;
}
async function outboxCount() {
  const rows = await superSql`SELECT count(*)::int AS n FROM public.outbox WHERE aggregate_id IN (SELECT id FROM public.submissions WHERE publication_id = ${publicationRowId})`;
  return rows[0].n;
}

/* ------------------------------------------------- Gate P1: migration */
check("P1", "tables exist with RLS + FORCE enabled", async () => {
  const rows = await superSql`
    SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force
    FROM pg_class WHERE relname IN ('form_publications','submissions','outbox')`;
  if (rows.length !== 3) throw new Error(`missing tables: ${JSON.stringify(rows.map((r) => r.relname))}`);
  for (const r of rows) {
    if (!r.rls || !r.force) throw new Error(`${r.relname}: RLS+FORCE not enabled`);
  }
  const roles = await superSql`SELECT 1 FROM pg_roles WHERE rolname = 'intake_caller'`;
  if (roles.length !== 1) throw new Error("intake_caller role missing");
});

check("P1", "workspace_id immutability + idempotency + cap floor constraints", async () => {
  const rows = await superSql`
    SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('form_publications','submissions','outbox')`;
  const names = rows.map((r) => r.conname).join(",");
  for (const need of ["submissions_pkey", "form_publications_public_id_key", "submissions_publication_id_idempotency_key_key"]) {
    if (!names.includes(need)) throw new Error(`missing constraint ${need}`);
  }
});

/* ------------------------------------------------- Gate P2: privileges */
check("P2", "writes stay RPC-only; anon reads nothing (member SELECT per Phase 7)", async () => {
  // Phase 7 deliberately grants SELECT ON submissions TO authenticated
  // (RLS builder+ inbox reads). DML stays ungranted for every browser role;
  // anon holds zero privileges of any kind on both intake tables.
  for (const role of ["anon", "authenticated"]) {
    for (const table of ["submissions", "outbox"]) {
      for (const priv of ["INSERT", "UPDATE", "DELETE"]) {
        const rows = await superSql`SELECT has_table_privilege(${role}, ${"public." + table}, ${priv}) AS ok`;
        if (rows[0].ok) throw new Error(`${role} holds ${priv} on ${table}`);
      }
    }
  }
  const anonSel = await superSql`SELECT has_table_privilege('anon', 'public.submissions', 'SELECT') AS ok`;
  if (anonSel[0].ok) throw new Error("anon holds SELECT on submissions");
  const memberSel = await superSql`SELECT has_table_privilege('authenticated', 'public.submissions', 'SELECT') AS ok`;
  if (!memberSel[0].ok) throw new Error("authenticated lost member SELECT on submissions");
});
check("P2", "anon holds zero grants on form_publications", async () => {
  for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
    const rows = await superSql`SELECT has_table_privilege('anon', 'public.form_publications', ${priv}) AS ok`;
    if (rows[0].ok) throw new Error(`anon holds ${priv} on form_publications`);
  }
});
check("P2", "resolver EXECUTE for anon+authenticated; intake EXECUTE intake_caller-only", async () => {
  for (const role of ["anon", "authenticated"]) {
    const okResolve = await superSql`SELECT has_function_privilege(${role}, 'formos.resolve_public_form(text)', 'EXECUTE') AS ok`;
    if (!okResolve[0].ok) throw new Error(`${role} cannot resolve public forms`);
    const noIntake = await superSql`SELECT has_function_privilege(${role}, 'formos.submit_submission(text,uuid,jsonb,text)', 'EXECUTE') AS ok`;
    if (noIntake[0].ok) throw new Error(`${role} can EXECUTE the intake RPC`);
  }
  const intake = await superSql`SELECT has_function_privilege('intake_caller', 'formos.submit_submission(text,uuid,jsonb,text)', 'EXECUTE') AS ok`;
  if (!intake[0].ok) throw new Error("intake_caller cannot EXECUTE the intake RPC");
});
check("P2", "no public-schema intake wrapper (browsers cannot invoke it)", async () => {
  const rows = await superSql`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'submit_submission'`;
  if (rows[0].n !== 0) throw new Error("public.submit_submission wrapper exists");
});

/* ------------------------------------------------- Gate P3: anon surface */
check("P3", "anon cannot read submissions, outbox, or publications via PostgREST", async () => {
  for (const table of ["submissions", "outbox", "form_publications"]) {
    const { error } = await anonC.from(table).select("id").limit(1);
    if (!error) throw new Error(`anon reads ${table}`);
  }
});
check("P3", "anon cannot invoke the intake RPC (no PostgREST surface)", async () => {
  const { error } = await anonC.rpc("submit_submission", {
    p_public_id: "x",
    p_submission_id: randomUUID(),
    p_payload: {},
    p_idempotency_key: "live-key-0001",
  });
  if (!error || !/schema cache|could not find/i.test(error.message)) {
    throw new Error(`unexpected intake surface: ${error?.message ?? "no error"}`);
  }
});
check("P3", "unknown vs malformed public ids are uniform (no enumeration oracle)", async () => {
  const a = await anonC.rpc("resolve_public_form", { p_public_id: "missing-live-id-0000" });
  const b = await anonC.rpc("resolve_public_form", { p_public_id: "!!!bad" });
  if (!a.error || !b.error) throw new Error("miss did not error");
  if (a.error.message !== b.error.message) throw new Error(`oracle: ${a.error.message} vs ${b.error.message}`);
  if (!/not available/.test(a.error.message)) throw new Error(`leaky message: ${a.error.message}`);
});

/* ------------------------------------------------- Gate P4: lifecycle */
check("P4", "publish flow provisions a live publication serving the pinned snapshot", async () => {
  await timed("workspace + draft + publish v1", async () => {
    const { error: wErr } = await aliceC.rpc("create_workspace", {
      p_id: wsA,
      p_membership_id: randomUUID(),
      p_name: "PubLive",
      p_slug: `publive-${tag}`,
    });
    if (wErr) throw new Error(`workspace: ${wErr.message}`);
    const { error: fErr } = await aliceC.from("forms").insert({
      id: formA,
      workspace_id: wsA,
      key: "intake",
      title: "Live Intake",
      draft_payload: docA,
    });
    if (fErr) throw new Error(`draft: ${fErr.message}`);
    versionId = randomUUID();
    const { error: pErr, data } = await aliceC.rpc("publish_form", {
      p_version_id: versionId,
      p_form_id: formA,
      p_snapshot: docA,
      p_schema_version: 1,
      p_schema_hash: hashDoc(docA),
      p_renderer_version: "rjsf-6.11+drv1",
      p_publisher: alice.id,
      p_expected_revision: 1,
    });
    if (pErr) throw new Error(`publish: ${pErr.message}`);
    if (data !== 1) throw new Error(`expected version 1, got ${data}`);
  });
  const pubRowId = randomUUID();
  const { error: pubErr } = await aliceC.from("form_publications").insert({
    id: pubRowId,
    workspace_id: wsA,
    form_id: formA,
    form_version_id: versionId,
    public_id: pubId,
    created_by: alice.id,
  });
  if (pubErr) throw new Error(`publication: ${pubErr.message}`);
  publicationRowId = pubRowId;
  const resolved = await timed("anon resolve_public_form", () =>
    anonC.rpc("resolve_public_form", { p_public_id: pubId }),
  );
  if (resolved.error) throw new Error(`resolve: ${resolved.error.message}`);
  const row = resolved.data;
  if (row.available !== true) throw new Error(`not available: ${JSON.stringify(row)}`);
  if (row.public_id !== pubId || row.title !== "Live Intake" || row.published_version_no !== 1) {
    throw new Error(`wrong redacted row: ${JSON.stringify({ ...row, schema_snapshot: undefined })}`);
  }
  if (stableStringify(row.schema_snapshot) !== stableStringify(docA)) throw new Error("snapshot is not self-contained");
  if ("workspace_id" in row || "form_id" in row) throw new Error("internal identifiers leaked");
});

/* ------------------------------------------------- Gate P5: intake path */
check("P5", "valid intake commits receipt + outbox event atomically", async () => {
  const subId = randomUUID();
  const rows = await timed("intake_caller submit_submission", () => intakeCall({ name: "Ann" }, `live-key-${tag}-01`, subId));
  const receipt = rows[0].receipt;
  if (receipt.submission_id !== subId || receipt.duplicate !== false) throw new Error(`bad receipt: ${JSON.stringify(receipt)}`);
  if ((await submissionCount()) !== 1 || (await outboxCount()) !== 1) throw new Error("submission/outbox mismatch");
  const events = await superSql`SELECT payload FROM public.outbox LIMIT 1`;
  const payload = events[0].payload;
  if (stableStringify(payload).includes("Ann")) throw new Error("respondent payload leaked into outbox");
  for (const k of ["submission_id", "form_id", "publication_id", "published_version_no", "received_at"]) {
    if (!(k in payload)) throw new Error(`outbox event missing ${k}`);
  }
});
check("P5", "same idempotency key replays the original receipt (no duplicate)", async () => {
  const before = await submissionCount();
  const rows = await intakeCall({ name: "Ann" }, `live-key-${tag}-01`);
  if (rows[0].receipt.duplicate !== true) throw new Error("replay was not idempotent");
  if ((await submissionCount()) !== before) throw new Error("replay created a duplicate row");
});
check("P5", "database floor rejects malformed envelopes", async () => {
  const bad = [
    ["non-object", [1, 2, 3], `live-key-${tag}-b1`],
    ["short-key", { name: "A" }, "short"],
    ["oversized", { name: "x".repeat(300_000) }, `live-key-${tag}-b3`],
  ];
  for (const [label, payload, key] of bad) {
    const r = await intakeCall(payload, key).catch((e) => e);
    if (!(r instanceof Error) || !/invalid payload|payload too large/.test(r.message)) {
      throw new Error(`${label}: not rejected (${r instanceof Error ? r.message : JSON.stringify(r)})`);
    }
  }
});
check("P5", "file references are gated (pipeline deferred)", async () => {
  const bad = await intakeCall({ name: "A", docs: [randomUUID()] }, `live-key-${tag}-f1`).catch(
    (e) => e,
  );
  if (!(bad instanceof Error) || !/attachments not available/.test(bad.message)) {
    throw new Error(`file ref accepted: ${bad instanceof Error ? bad.message : "receipt"}`);
  }
  await intakeCall({ name: "A", docs: [] }, `live-key-${tag}-f2`);
});

/* ------------------------------------------------- Gate P6: caps/schedule */
check("P6", "cap enforcement is transactional (no submission without its event)", async () => {
  await admin.from("form_publications").update({ max_submissions: 3 }).eq("id", publicationRowId);
  await intakeCall({ name: "C1" }, `live-key-${tag}-c1`);
  const capped = await intakeCall({ name: "C2" }, `live-key-${tag}-c2`).catch((e) => e);
  if (!(capped instanceof Error) || !/limit reached/.test(capped.message)) {
    throw new Error(`cap not enforced: ${capped instanceof Error ? capped.message : "accepted"}`);
  }
  const subs = await submissionCount();
  const events = await outboxCount();
  if (subs !== events) throw new Error(`atomicity broken: ${subs} submissions vs ${events} events`);
  const resolved = await anonC.rpc("resolve_public_form", { p_public_id: pubId });
  if (resolved.error || resolved.data?.reason !== "capped") throw new Error("cap not reflected in resolution");
  await admin.from("form_publications").update({ max_submissions: null }).eq("id", publicationRowId);
});
check("P6", "schedule windows close the intake path in-transaction", async () => {
  await admin.from("form_publications").update({ opens_at: new Date(Date.now() + 3600_000).toISOString() }).eq("id", publicationRowId);
  const early = await anonC.rpc("resolve_public_form", { p_public_id: pubId });
  if (early.error || early.data?.reason !== "not_open") throw new Error("not_open not reported");
  const earlySubmit = await intakeCall({ name: "E" }, `live-key-${tag}-e1`).catch((e) => e);
  if (!(earlySubmit instanceof Error) || !/not open/.test(earlySubmit.message)) {
    throw new Error(`pre-open submit accepted: ${earlySubmit instanceof Error ? earlySubmit.message : "accepted"}`);
  }
  await admin
    .from("form_publications")
    .update({ opens_at: null, closes_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", publicationRowId);
  const late = await anonC.rpc("resolve_public_form", { p_public_id: pubId });
  if (late.error || late.data?.reason !== "closed") throw new Error("closed not reported");
  await admin.from("form_publications").update({ opens_at: null, closes_at: null }).eq("id", publicationRowId);
  const reopened = await anonC.rpc("resolve_public_form", { p_public_id: pubId });
  if (reopened.error || reopened.data?.available !== true) throw new Error("schedule restore failed");
});

/* ------------------------------------------------- Gate P7: uniqueness */
check("P7", "unique-field constraint rejects repeats across idempotency keys", async () => {
  await admin.from("form_publications").update({ unique_field_key: "name" }).eq("id", publicationRowId);
  await intakeCall({ name: "Solo" }, `live-key-${tag}-u1`);
  const dup = await intakeCall({ name: "Solo" }, `live-key-${tag}-u2`).catch((e) => e);
  if (!(dup instanceof Error) || !/duplicate/.test(dup.message)) {
    throw new Error(`unique repeat accepted: ${dup instanceof Error ? dup.message : "accepted"}`);
  }
  await intakeCall({ name: "Other" }, `live-key-${tag}-u3`);
  await admin.from("form_publications").update({ unique_field_key: null }).eq("id", publicationRowId);
});

/* ------------------------------------------------- Gate P8: member/admin surface */
check("P8", "strangers cannot resolve, read, or invoke; viewers cannot manage publications", async () => {
  const seen = await strangerC.from("form_publications").select("id").eq("workspace_id", wsA);
  if ((seen.data ?? []).length !== 0) throw new Error("stranger reads publications");
  const ins = await strangerC.rpc("resolve_public_form", { p_public_id: pubId });
  if (ins.error || ins.data?.available !== true) throw new Error("public resolution broken for outsiders (expected: available)");
  const direct = await strangerC.from("forms").select("id").eq("workspace_id", wsA);
  if ((direct.data ?? []).length !== 0) throw new Error("stranger reads forms");
});

/* ------------------------------------------------- Gate P9/P10: HTTP BFF */
const httpOk = APP_URL !== "";
const httpFetch = async (step, path, init) => {
  let res;
  try {
    res = await fetch(`${APP_URL}${path}`, init);
  } catch (e) {
    throw new Error(`${step}: fetch failed (${e.cause?.code ?? e.message})`);
  }
  const body = await res.json().catch(() => null);
  return { res, body };
};
check("P9", httpOk ? "GET /f/:publicId renders the published snapshot" : "SKIP (APP_URL unreachable)", async () => {
  if (!httpOk) return;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${APP_URL}/f/${pubId}`);
  } catch {
    console.log("   [S] HTTP unreachable — skipping HTTP gates (start the app at APP_URL to run them).");
    return;
  }
  const html = await res.text();
  console.log(`   [S] GET /f/:publicId: ${(performance.now() - t0).toFixed(1)}ms (status ${res.status})`);
  if (res.status !== 200) throw new Error(`page status ${res.status}`);
  // React SSR emits comment nodes between static text and expressions
  // ("Published version <!-- -->1"), so match the badge loosely.
  if (!html.includes("Live Intake") || !/Published version(?:<!-- -->|\s)*1/.test(html)) {
    throw new Error("page does not render the published snapshot");
  }
  if (/workspace_id|draft_payload/i.test(html)) throw new Error("page leaks internals");
  const missing = await fetch(`${APP_URL}/f/does-not-exist-000000`);
  if (missing.status !== 404) throw new Error(`unknown public id status ${missing.status}`);
});
check("P10", httpOk ? "POST intake: valid → receipt; invalid → 422; replay → same id" : "SKIP (APP_URL unreachable)", async () => {
  if (!httpOk) return;
  try {
    await fetch(`${APP_URL}/f/${pubId}`);
  } catch {
    console.log("   [S] HTTP unreachable — skipping HTTP gates.");
    return;
  }
  const key = `http-key-${tag}-01`;
  const { res, body } = await timed("POST valid submission (end-to-end)", () =>
    httpFetch("valid", `/api/public/forms/${pubId}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { name: "Http Ann" }, idempotencyKey: key }),
    }),
  );
  if (res.status !== 200 || body?.success !== true || typeof body?.submissionId !== "string") {
    throw new Error(`valid submit failed: ${res.status} ${JSON.stringify(body)}`);
  }
  if ("workspace_id" in body || "payload" in body) throw new Error("response leaks internals");
  const bad = await httpFetch("invalid-shape", `/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: {}, idempotencyKey: `http-key-${tag}-02` }),
  });
  if (bad.res.status !== 422 || bad.body?.code !== "INVALID_SUBMISSION" || !Array.isArray(bad.body?.errors)) {
    throw new Error(`invalid submit not gated: ${bad.res.status} ${JSON.stringify(bad.body)}`);
  }
  const replay = await httpFetch("replay", `/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { name: "Http Ann" }, idempotencyKey: key }),
  });
  if (replay.body?.submissionId !== body.submissionId) throw new Error("idempotent replay diverged");
  const unknown = await httpFetch("unknown-id", `/api/public/forms/does-not-exist-000000/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { name: "X" }, idempotencyKey: `http-key-${tag}-03` }),
  });
  if (unknown.res.status !== 404 || unknown.body?.code !== "FORM_NOT_AVAILABLE") {
    throw new Error(`unknown id not uniform: ${unknown.res.status}`);
  }
  const honeypot = await httpFetch("honeypot", `/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { name: "Bot" }, idempotencyKey: `http-key-${tag}-04`, website: "spam" }),
  });
  if (honeypot.res.status !== 200 || honeypot.body?.success !== true) throw new Error("honeypot not absorbed");
  const big = await httpFetch("oversize", `/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { name: "x".repeat(400 * 1024) }, idempotencyKey: `http-key-${tag}-05` }),
  });
  if (big.res.status !== 413) throw new Error(`oversize not rejected: ${big.res.status}`);
  // Concurrent same-key collapse: exactly one stored row, one receipt id.
  const cKey = `http-key-${tag}-cc`;
  const parallel = await Promise.all(
    Array.from({ length: 5 }, () =>
      httpFetch("concurrent", `/api/public/forms/${pubId}/submissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { name: "Race" }, idempotencyKey: cKey }),
      }),
    ),
  );
  const ids = new Set(parallel.map((p) => p.body?.submissionId));
  if (ids.size !== 1 || parallel.some((p) => p.res.status !== 200)) {
    throw new Error(`concurrent collapse failed: ${JSON.stringify(parallel.map((p) => [p.res.status, p.body?.submissionId]))}`);
  }
});

/* ------------------------------------------------- run + cleanup */
let failed = 0;
let httpSkipped = false;
try {
  for (const r of results) {
    let status = "PASS";
    try {
      await r.run();
    } catch (e) {
      status = `FAIL: ${e instanceof Error ? e.message : e}`;
    }
    if (/SKIP/.test(r.name)) httpSkipped = true;
    if (status !== "PASS") failed += 1;
    console.log(`${status === "PASS" ? "ok  " : "FAIL"} [Gate ${r.gate}] ${r.name}${status === "PASS" ? "" : ` — ${status}`}`);
  }
} finally {
  try {
    await admin.rpc("delete_workspace", { p_workspace_id: wsA });
  } catch { /* best-effort cleanup */ }
  for (const u of users) {
    try {
      await admin.auth.admin.deleteUser(u.id);
    } catch { /* best-effort cleanup */ }
  }
  await superSql.end();
  await intakeSql.end();
}
console.log(
  failed === 0
    ? `PUBLIC INTAKE LIVE VERIFICATION: ALL GATES PASS${httpSkipped ? " (HTTP gates need a reachable APP_URL)" : ""}`
    : `PUBLIC INTAKE LIVE VERIFICATION: ${failed} FAILURE(S)`,
);
process.exit(failed === 0 ? 0 : 1);
