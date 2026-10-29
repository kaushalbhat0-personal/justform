#!/usr/bin/env node
/**
 * Live Supabase verification for IMPL-011 workflow foundation (Gates W1–W9).
 * Requires migration 0017 applied (`supabase db push`) plus:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (PostgREST),
 *   DATABASE_URL (direct superuser connection for privilege probes),
 *   INTAKE_DB_ROLE_PASSWORD (least-privilege intake_caller credential).
 *
 * Proves against the REAL project: definition lifecycle + version immutability,
 * atomic intake autostart, assignment, approval incl. a concurrent-decision
 * race, tenant isolation, full RBAC ladder (owner/admin/builder/
 * data_collaborator/viewer/anon/outsider), receipt-only outbox payloads,
 * Stage-0 tick compatibility, and metering integrity. Never prints
 * secrets/tokens (only lengths, counts, timings).
 *
 * Cleanup is best-effort: workspaces holding published versions cannot be
 * deleted while the known immutable-version deletion issue stands (reported,
 * not fixed here). The script reports the deletion outcome explicitly.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

/* ------------------------------------------------------------------ env */
for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, INTAKE_DB_ROLE_PASSWORD } =
  process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !DATABASE_URL || !INTAKE_DB_ROLE_PASSWORD) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, INTAKE_DB_ROLE_PASSWORD.");
  process.exit(0);
}
console.log(`env: anonKeyLen=${SUPABASE_ANON_KEY.length} intakePwdLen=${INTAKE_DB_ROLE_PASSWORD.length}`);

/* ------------------------------------------------- connections */
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
function poolerEndpoint() {
  const raw = readFileSync(new URL("../../supabase/.temp/pooler-url", import.meta.url), "utf8").trim();
  const u = new URL(raw);
  return { hostname: u.hostname, port: Number(u.port) || 5432 };
}
function poolerOpts(user, password) {
  const ep = poolerEndpoint();
  return { host: ep.hostname, port: ep.port, database: "postgres", user: `${user}.${projectRef}`, password, ssl: "require" };
}
async function connectResilient(user, password, options, label) {
  try {
    const sql = postgres({ ...directOpts(user, password), ...options, connect_timeout: 8 });
    await sql`SELECT 1 AS ok`;
    console.log(`${label}: direct connection ok`);
    return sql;
  } catch (e) {
    console.log(`${label}: direct failed (${e.code ?? e.message}), trying pooler…`);
    const sql = postgres({ ...poolerOpts(user, password), ...options, connect_timeout: 15 });
    await sql`SELECT 1 AS ok`;
    console.log(`${label}: pooler connection ok`);
    return sql;
  }
}
const superUser = new URL(DATABASE_URL).username || "postgres";
const superSql = await connectResilient(superUser, decodeURIComponent(new URL(DATABASE_URL).password), { max: 1, prepare: false }, "superuser");
{
  const escaped = INTAKE_DB_ROLE_PASSWORD.replace(/'/g, "''");
  await superSql.unsafe(`ALTER ROLE intake_caller WITH LOGIN PASSWORD '${escaped}'`);
  console.log("intake_caller login provisioned (length check only).");
}
async function connectIntake(attempts = 6) {
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await connectResilient("intake_caller", INTAKE_DB_ROLE_PASSWORD, { max: 3, prepare: false }, `intake_caller (attempt ${i})`);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw last ?? new Error("intake_caller unreachable");
}
const intakeSql = await connectIntake();

/* ------------------------------------------------- fixtures */
const tag = Date.now().toString(36);
const email = (n) => `wf-${n}-${tag}@example.test`;
const users = {};
for (const n of ["alice", "bob", "cara", "dave", "eve", "mallory"]) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(n), password: "Verify123!", email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${n}: ${error?.message}`);
  users[n] = data.user;
}
const clients = {};
for (const n of ["alice", "bob", "cara", "dave", "eve", "mallory"]) {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error } = await c.auth.signInWithPassword({ email: email(n), password: "Verify123!" });
  if (error) throw new Error(`login ${n}: ${error.message}`);
  clients[n] = c;
}

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const formB = randomUUID();
const ver1 = randomUUID();
const pubRow = randomUUID();
const pubId = `wf-live-${tag}`.slice(0, 22);
const subIds = { s1: randomUUID(), s2: randomUUID(), s3: randomUUID(), s4: randomUUID(), s5: randomUUID(), sB: randomUUID() };
const defA = null; // resolved after create (public wrapper mints a deterministic id)

const doc = {
  id: formA, key: "leave", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Leave Request" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "reason", type: "short_text", label: "Reason", required: true },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};
const CONFIG = { trigger: "submission.created", steps: [{ type: "approval", key: "approval", assignee: "unassigned" }] };

async function fixture() {
  const r1 = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "Airport", p_slug: `airport-${tag}` });
  if (r1.error) throw new Error(`wsA: ${r1.error.message}`);
  const r2 = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "Other", p_slug: `other-${tag}` });
  if (r2.error) throw new Error(`wsB: ${r2.error.message}`);
  for (const [role, n] of [["admin", "bob"], ["builder", "cara"], ["data_collaborator", "dave"], ["viewer", "eve"]]) {
    const { error } = await admin.from("memberships").insert({ id: randomUUID(), workspace_id: wsA, user_id: users[n].id, role });
    if (error) throw new Error(`membership ${n}/${role}: ${error.message}`);
  }
  for (const [fid, key, title] of [[formA, "leave", "Leave Request"], [formB, "leave2", "Leave 2"]]) {
    const { error } = await clients.alice.from("forms").insert({ id: fid, workspace_id: wsA, key, title, draft_payload: doc });
    if (error) throw new Error(`form ${key}: ${error.message}`);
  }
  const { error: vErr } = await admin.from("form_versions").insert({ id: ver1, form_id: formA, workspace_id: wsA, published_version_no: 1, schema_snapshot: doc, schema_version: 1, schema_hash: "h1", renderer_version: "r", publisher_id: users.alice.id });
  if (vErr) throw new Error(`version: ${vErr.message}`);
  const { error: pErr } = await admin.from("form_publications").insert({ id: pubRow, workspace_id: wsA, form_id: formA, form_version_id: ver1, public_id: pubId, created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
}
await fixture();

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const rpcErr = (r) => r.error?.message ?? "succeeded unexpectedly";
const expectErr = (r, re, label) => {
  if (!r.error || !re.test(r.error.message)) throw new Error(`${label}: ${rpcErr(r)}`);
};

const intakeSubmit = async (subId, key, payload = { reason: "vacation" }) => {
  const rows = await intakeSql`SELECT formos.submit_submission(${pubId}, ${subId}::uuid, ${intakeSql.json(payload)}, ${key}) AS receipt`;
  return rows[0].receipt;
};
const taskFor = async (c, subId) => {
  const { data, error } = await c.from("workflow_tasks").select("id,status,outcome,assignee_user_id,claimed_by,instance_id").eq("submission_id", subId).maybeSingle();
  if (error) throw new Error(`task read: ${error.message}`);
  return data;
};

/* ---------------- W1: definition lifecycle ---------------- */
let versionIdV1 = null;
let defAId = null;
check("W1", "create + invalid config + duplicate + activate", async () => {
  const bad = await clients.alice.rpc("create_workflow_definition", { p_form_id: formA, p_config: { trigger: "cron", steps: [] } });
  expectErr(bad, /invalid workflow config/, "bad config accepted");
  const ok = await clients.alice.rpc("create_workflow_definition", { p_form_id: formA, p_config: CONFIG });
  if (ok.error) throw new Error(`create: ${ok.error.message}`);
  const dup = await clients.alice.rpc("create_workflow_definition", { p_form_id: formA, p_config: CONFIG });
  expectErr(dup, /already exists/, "duplicate accepted");
  // NOTE: the public wrapper mints a deterministic id; resolve it for later gates.
  const row = await clients.alice.from("workflow_definitions").select("id,current_version_id").eq("form_id", formA).maybeSingle();
  if (row.error || !row.data) throw new Error(`def read: ${row.error?.message}`);
  defAId = row.data.id;
  const act = await clients.alice.rpc("activate_workflow", { p_definition_id: defAId });
  if (act.error) throw new Error(`activate: ${act.error.message}`);
  if (act.data.version_no !== 1) throw new Error(`first version_no: ${act.data.version_no}`);
  // Re-read AFTER activation: the pointer is set by the activate transaction.
  const after = await clients.alice.from("workflow_definitions").select("current_version_id").eq("form_id", formA).maybeSingle();
  if (after.error || !after.data) throw new Error(`def re-read: ${after.error?.message}`);
  versionIdV1 = after.data.current_version_id;
  if (!versionIdV1) throw new Error("no current_version_id after activate");
});
check("W1", "anon cannot invoke workflow mutations", async () => {
  for (const [fn, args] of [["create_workflow_definition", { p_form_id: formB, p_config: CONFIG }], ["activate_workflow", { p_definition_id: defAId }], ["claim_task", { p_task_id: randomUUID() }], ["decide_task", { p_task_id: randomUUID(), p_outcome: "approved" }]]) {
    const r = await anonC.rpc(fn, args);
    if (!r.error) throw new Error(`anon ${fn} succeeded`);
  }
});

/* ---------------- W2: intake autostart + idempotency + metering ---------------- */
check("W2", "intake autostarts instance + task atomically", async () => {
  const receipt = await intakeSubmit(subIds.s1, `wf-key-${tag}-1`);
  if (receipt.duplicate || receipt.workflow_started !== true) throw new Error(`receipt: ${JSON.stringify(receipt)}`);
  const t = await taskFor(clients.alice, subIds.s1);
  if (!t || t.status !== "pending" || t.outcome !== "pending") throw new Error(`task: ${JSON.stringify(t)}`);
  const inst = await superSql`SELECT status, workflow_version_id FROM public.workflow_instances WHERE submission_id = ${subIds.s1}`;
  if (inst.length !== 1 || inst[0].status !== "in_progress") throw new Error(`instance: ${JSON.stringify(inst)}`);
  if (inst[0].workflow_version_id !== versionIdV1) throw new Error("instance not pinned to active version");
});
check("W2", "idempotent replay creates no second instance; metering counts once", async () => {
  const before = await superSql`SELECT count(*)::int AS n FROM public.workflow_instances WHERE submission_id = ${subIds.s1}`;
  const receipt = await intakeSubmit(subIds.s1, `wf-key-${tag}-1`);
  if (receipt.duplicate !== true || receipt.submission_id !== subIds.s1) throw new Error(`replay: ${JSON.stringify(receipt)}`);
  const after = await superSql`SELECT count(*)::int AS n FROM public.workflow_instances WHERE submission_id = ${subIds.s1}`;
  if (after[0].n !== before[0].n || after[0].n !== 1) throw new Error("replay duplicated the instance");
  const usage = await superSql`SELECT count(*)::int AS n FROM public.usage_events WHERE workspace_id = ${wsA} AND metric = 'submission' AND source_id = ${subIds.s1}`;
  if (usage[0].n !== 1) throw new Error(`metering double-count: ${usage[0].n}`);
});

/* ---------------- W3: assignment ---------------- */
let task1 = null;
check("W3", "claim → forbidden release → release → assign → negatives", async () => {
  task1 = await taskFor(clients.alice, subIds.s1);
  const claim = await clients.bob.rpc("claim_task", { p_task_id: task1.id });
  if (claim.error || claim.data.status !== "claimed") throw new Error(`claim: ${rpcErr(claim)}`);
  const again = await clients.cara.rpc("claim_task", { p_task_id: task1.id });
  expectErr(again, /conflict/, "second claim on claimed task");
  const relForbidden = await clients.cara.rpc("release_task", { p_task_id: task1.id });
  expectErr(relForbidden, /forbidden/, "non-claimer builder release");
  const rel = await clients.bob.rpc("release_task", { p_task_id: task1.id });
  if (rel.error) throw new Error(`release: ${rel.error.message}`);
  const asg = await clients.alice.rpc("assign_task", { p_task_id: task1.id, p_assignee: users.bob.id });
  if (asg.error) throw new Error(`assign: ${asg.error.message}`);
  const asgOut = await clients.alice.rpc("assign_task", { p_task_id: task1.id, p_assignee: users.mallory.id });
  expectErr(asgOut, /not a workspace member/, "outsider assign");
  for (const [n, c] of [["dave", clients.dave], ["eve", clients.eve]]) {
    const r = await c.rpc("claim_task", { p_task_id: task1.id });
    expectErr(r, /forbidden/, `${n} claim`);
  }
  const m = await clients.mallory.rpc("claim_task", { p_task_id: task1.id });
  if (!m.error || !/forbidden|not found/.test(m.error.message)) throw new Error(`outsider claim: ${rpcErr(m)}`);
});

/* ---------------- W4: approval + concurrency ---------------- */
check("W4", "approve completes; repeat + invalid outcome conflict", async () => {
  const claim = await clients.bob.rpc("claim_task", { p_task_id: task1.id });
  if (claim.error) throw new Error(`re-claim: ${claim.error.message}`);
  const dec = await clients.alice.rpc("decide_task", { p_task_id: task1.id, p_outcome: "approved" });
  if (dec.error || dec.data.instance_status !== "completed") throw new Error(`approve: ${rpcErr(dec)}`);
  const repeat = await clients.bob.rpc("decide_task", { p_task_id: task1.id, p_outcome: "approved" });
  expectErr(repeat, /conflict/, "second approve");
  const invalid = await clients.alice.rpc("decide_task", { p_task_id: task1.id, p_outcome: "maybe" });
  expectErr(invalid, /invalid outcome/, "bad outcome");
  const inst = await superSql`SELECT status FROM public.workflow_instances WHERE submission_id = ${subIds.s1}`;
  if (inst[0].status !== "completed") throw new Error("instance not completed");
  const sub = await superSql`SELECT payload FROM public.submissions WHERE id = ${subIds.s1}`;
  if (sub[0].payload.reason !== "vacation") throw new Error("submission payload disturbed");
});
check("W4", "concurrent approve race: exactly one winner", async () => {
  await intakeSubmit(subIds.s2, `wf-key-${tag}-2`);
  const t = await taskFor(clients.alice, subIds.s2);
  const [a, b] = await Promise.allSettled([
    clients.alice.rpc("decide_task", { p_task_id: t.id, p_outcome: "approved" }),
    clients.bob.rpc("decide_task", { p_task_id: t.id, p_outcome: "approved" }),
  ]);
  const wins = [a, b].filter((r) => r.status === "fulfilled" && !r.value.error);
  const conflicts = [a, b].filter((r) => r.status === "fulfilled" && /conflict/.test(r.value.error?.message ?? ""));
  if (wins.length !== 1 || conflicts.length !== 1) {
    throw new Error(`race not deterministic: wins=${wins.length} conflicts=${conflicts.length}`);
  }
});
check("W4", "reject path ends as rejected", async () => {
  await intakeSubmit(subIds.s3, `wf-key-${tag}-3`);
  const t = await taskFor(clients.alice, subIds.s3);
  const claim = await clients.bob.rpc("claim_task", { p_task_id: t.id });
  if (claim.error) throw new Error(`claim: ${claim.error.message}`);
  const dec = await clients.alice.rpc("decide_task", { p_task_id: t.id, p_outcome: "rejected" });
  if (dec.error || dec.data.instance_status !== "rejected") throw new Error(`reject: ${rpcErr(dec)}`);
  const again = await clients.alice.rpc("decide_task", { p_task_id: t.id, p_outcome: "rejected" });
  expectErr(again, /conflict/, "decide after reject");
});

/* ---------------- W5: isolation ---------------- */
check("W5", "outsider sees zero workflow rows; cross-ws mutations denied", async () => {
  for (const tbl of ["workflow_definitions", "workflow_versions", "workflow_instances", "workflow_tasks"]) {
    const { data } = await clients.mallory.from(tbl).select("id").eq("workspace_id", wsA);
    if ((data ?? []).length !== 0) throw new Error(`mallory reads ${tbl}`);
  }
  const vars = await clients.mallory.from("workflow_versions").select("id").eq("id", versionIdV1);
  if ((vars.data ?? []).length !== 0) throw new Error("mallory reads version by id");
  for (const [fn, args] of [["claim_task", { p_task_id: task1.id }], ["decide_task", { p_task_id: task1.id, p_outcome: "approved" }], ["activate_workflow", { p_definition_id: defAId }]]) {
    const r = await clients.mallory.rpc(fn, args);
    if (!r.error || !/forbidden|not found/.test(r.error.message)) throw new Error(`mallory ${fn}: ${rpcErr(r)}`);
  }
  const mk = await clients.mallory.rpc("create_workflow_definition", { p_form_id: formA, p_config: CONFIG });
  if (!mk.error) throw new Error("mallory created definition on foreign form");
});

/* ---------------- W6: immutability + pinning ---------------- */
check("W6", "workflow versions immutable even for service role", async () => {
  const up = await superSql`UPDATE public.workflow_versions SET status = 'archived' WHERE id = ${versionIdV1}`.catch((e) => e);
  if (!(up instanceof Error) || !/immutable/.test(up.message)) throw new Error(`version update: ${up instanceof Error ? up.message : "allowed"}`);
  const del = await superSql`DELETE FROM public.workflow_versions WHERE id = ${versionIdV1}`.catch((e) => e);
  if (!(del instanceof Error) || !/immutable/.test(del.message)) throw new Error(`version delete: ${del instanceof Error ? del.message : "allowed"}`);
});
check("W6", "reactivation versions forward; in-flight instance stays pinned to v1", async () => {
  const act = await clients.alice.rpc("activate_workflow", { p_definition_id: defAId });
  if (act.error || act.data.version_no !== 2) throw new Error(`reactivate: ${rpcErr(act)}`);
  const inst = await superSql`SELECT workflow_version_id FROM public.workflow_instances WHERE submission_id = ${subIds.s1}`;
  if (inst[0].workflow_version_id !== versionIdV1) throw new Error("in-flight instance repointed");
});

/* ---------------- W7: RBAC ladder ---------------- */
check("W7", "data_collaborator/viewer cannot manage; builder can work, cannot archive", async () => {
  const mk = await clients.dave.rpc("create_workflow_definition", { p_form_id: formB, p_config: CONFIG });
  expectErr(mk, /forbidden/, "data_collaborator create");
  const mk2 = await clients.eve.rpc("create_workflow_definition", { p_form_id: formB, p_config: CONFIG });
  expectErr(mk2, /forbidden/, "viewer create");
  const arch = await clients.cara.rpc("archive_workflow", { p_definition_id: defAId });
  expectErr(arch, /forbidden/, "builder archive");
  // builder CAN claim/decide (operational floor).
  await intakeSubmit(subIds.s5, `wf-key-${tag}-5`);
  const t = await taskFor(clients.alice, subIds.s5);
  const claim = await clients.cara.rpc("claim_task", { p_task_id: t.id });
  if (claim.error) throw new Error(`builder claim: ${claim.error.message}`);
  const dec = await clients.cara.rpc("decide_task", { p_task_id: t.id, p_outcome: "approved" });
  if (dec.error) throw new Error(`builder decide: ${dec.error.message}`);
});
check("W7", "draft flow on second form; admin cancel; archive is terminal", async () => {
  const mk = await clients.alice.rpc("create_workflow_definition", { p_form_id: formB, p_config: CONFIG });
  if (mk.error) throw new Error(`formB create: ${mk.error.message}`);
  const row = await clients.alice.from("workflow_definitions").select("id").eq("form_id", formB).maybeSingle();
  const defB = row.data.id;
  const upd = await clients.alice.rpc("update_workflow_draft", { p_definition_id: defB, p_config: CONFIG });
  if (upd.error) throw new Error(`draft update: ${upd.error.message}`);
  const updBad = await clients.dave.rpc("update_workflow_draft", { p_definition_id: defB, p_config: CONFIG });
  expectErr(updBad, /forbidden/, "data_collaborator draft update");
  // manual start with no active workflow is a clean miss, not a silent start.
  const pubB = randomUUID();
  await admin.from("form_versions").insert({ id: randomUUID(), form_id: formB, workspace_id: wsA, published_version_no: 1, schema_snapshot: doc, schema_version: 1, schema_hash: "hB", renderer_version: "r", publisher_id: users.alice.id });
  const verB = (await superSql`SELECT id FROM public.form_versions WHERE form_id = ${formB}`).map((r) => r.id)[0];
  await admin.from("form_publications").insert({ id: pubB, workspace_id: wsA, form_id: formB, form_version_id: verB, public_id: `wfB-live-${tag}`.slice(0, 22), created_by: users.alice.id });
  const pubBRow = await superSql`SELECT public_id FROM public.form_publications WHERE id = ${pubB}`;
  if (pubBRow.length !== 1) throw new Error("formB publication insert failed (public_id CHECK?)");
  const pubBId = pubBRow[0].public_id;
  const rows = await intakeSql`SELECT formos.submit_submission(${pubBId}, ${subIds.sB}::uuid, ${intakeSql.json({ reason: "x" })}, ${`wf-key-${tag}-B`}) AS receipt`;
  if (rows[0].receipt.workflow_started !== false) throw new Error("submission started without active workflow");
  const startMiss = await clients.cara.rpc("start_workflow", { p_submission_id: subIds.sB });
  expectErr(startMiss, /no active workflow/, "manual start without active workflow");
  const actB = await clients.alice.rpc("activate_workflow", { p_definition_id: defB });
  if (actB.error) throw new Error(`formB activate: ${actB.error.message}`);
  const start = await clients.cara.rpc("start_workflow", { p_submission_id: subIds.sB });
  if (start.error || start.data.started !== true) throw new Error(`manual start: ${rpcErr(start)}`);
  const updAfter = await clients.alice.rpc("update_workflow_draft", { p_definition_id: defB, p_config: CONFIG });
  expectErr(updAfter, /only drafts/, "post-activation draft edit");
  // cancel path (admin) then decide-after-cancel conflicts.
  await intakeSubmit(subIds.s4, `wf-key-${tag}-4`);
  const t4 = await taskFor(clients.alice, subIds.s4);
  const cancel = await clients.bob.rpc("cancel_workflow", { p_instance_id: t4.instance_id });
  if (cancel.error || cancel.data.status !== "cancelled") throw new Error(`cancel: ${rpcErr(cancel)}`);
  const decAfter = await clients.alice.rpc("decide_task", { p_task_id: t4.id, p_outcome: "approved" });
  expectErr(decAfter, /conflict/, "decide after cancel");
  const cancelNope = await clients.cara.rpc("cancel_workflow", { p_instance_id: t4.instance_id });
  expectErr(cancelNope, /forbidden/, "builder cancel");
  // archive is terminal.
  const arch = await clients.bob.rpc("archive_workflow", { p_definition_id: defAId });
  if (arch.error) throw new Error(`archive: ${arch.error.message}`);
  const react = await clients.alice.rpc("activate_workflow", { p_definition_id: defAId });
  expectErr(react, /archived workflows/, "reactivate archived");
});

/* ---------------- W8/W9: receipts, outbox, tick, leak scan ---------------- */
check("W8", "RPC receipts are receipt-only (no payload bytes)", async () => {
  const t = await taskFor(clients.alice, subIds.s3);
  const dec = await clients.alice.rpc("decide_task", { p_task_id: t.id, p_outcome: "rejected" });
  if (!dec.error) throw new Error("expected conflict on decided task");
  for (const key of ["vacation", "reason", "payload"]) {
    for (const blob of [JSON.stringify(dec), JSON.stringify(t)]) {
      if (blob.includes(key)) throw new Error(`receipt leaks ${key}`);
    }
  }
});
check("W9", "workflow outbox events exist with receipt-only payloads", async () => {
  const rows = await superSql`SELECT event_type, payload::text AS p FROM public.outbox WHERE workspace_id = ${wsA} AND event_type LIKE 'workflow.%'`;
  const types = new Set(rows.map((r) => r.event_type));
  for (const need of ["workflow.activated", "workflow.started", "workflow.task.created", "workflow.task.completed", "workflow.completed"]) {
    if (!types.has(need)) throw new Error(`missing outbox event ${need} (have: ${[...types].join(",")})`);
  }
  for (const r of rows) {
    if (/vacation|"reason"/.test(r.p)) throw new Error(`outbox payload leaks respondent data: ${r.event_type}`);
  }
  const audit = await superSql`SELECT count(*)::int AS n FROM public.audit_log WHERE workspace_id = ${wsA} AND (diff::text LIKE '%vacation%' OR diff::text LIKE '%"reason"%')`;
  if (audit[0].n !== 0) throw new Error("audit metadata contains submission payload");
});
check("W9", "Stage-0 tick absorbs workflow events without failure", async () => {
  const res = await superSql`SELECT formos.tick_fanout(100) AS out`;
  const out = res[0].out;
  if ((out.failed ?? -1) !== 0) throw new Error(`tick failed: ${JSON.stringify(out)}`);
  const pending = await superSql`SELECT count(*)::int AS n FROM public.outbox WHERE workspace_id = ${wsA} AND event_type LIKE 'workflow.%' AND status IN ('pending','claimed')`;
  if (pending[0].n !== 0) throw new Error(`${pending[0].n} workflow events left unprocessed`);
});

/* ---------------- W10: workspace deletion probe (known issue + new surface) ---------------- */
check("W10", "workspace with workflow versions hits the version-immutability deletion blocker", async () => {
  const wsC = randomUUID();
  const formC = randomUUID();
  const mk = await clients.alice.rpc("create_workspace", { p_id: wsC, p_membership_id: randomUUID(), p_name: "DelProbe", p_slug: `delprobe-${tag}` });
  if (mk.error) throw new Error(`wsC: ${mk.error.message}`);
  const f = await clients.alice.from("forms").insert({ id: formC, workspace_id: wsC, key: "delprobe", title: "DelProbe", draft_payload: doc });
  if (f.error) throw new Error(`formC: ${f.error.message}`);
  const c = await clients.alice.rpc("create_workflow_definition", { p_form_id: formC, p_config: CONFIG });
  if (c.error) throw new Error(`defC: ${c.error.message}`);
  const d = await clients.alice.from("workflow_definitions").select("id").eq("form_id", formC).maybeSingle();
  const a = await clients.alice.rpc("activate_workflow", { p_definition_id: d.data.id });
  if (a.error) throw new Error(`activateC: ${a.error.message}`);
  // No form_versions exist here — only workflow rows. Deletion must still fail,
  // proving workflow_versions add an independent blocker beyond the known
  // form_versions issue (reported as carryover, not fixed here).
  const del = await admin.from("workspaces").delete().eq("id", wsC);
  if (!del.error || !/immutable/.test(del.error.message)) throw new Error(`wsC delete: ${del.error?.message ?? "succeeded unexpectedly"}`);
  // A version-free workspace deletes cleanly (control: wsB already proved this in cleanup).
});

/* ------------------------------------------------- run + cleanup */
let failed = 0;
let deletionNote = "";
try {
  for (const r of results) {
    const t0 = performance.now();
    let status = "PASS";
    try {
      await r.run();
    } catch (e) {
      status = `FAIL: ${e instanceof Error ? e.message : e}`;
    }
    if (status !== "PASS") failed += 1;
    console.log(`${status === "PASS" ? "ok  " : "FAIL"} [Gate ${r.gate}] ${r.name} (${(performance.now() - t0).toFixed(0)}ms)${status === "PASS" ? "" : ` — ${status}`}`);
  }
} finally {
  for (const ws of [wsA, wsB]) {
    try {
      const { error } = await admin.from("workspaces").delete().eq("id", ws);
      deletionNote += `ws=${ws.slice(0, 8)} delete ${error ? `FAILED: ${error.message}` : "ok"}; `;
    } catch (e) {
      deletionNote += `ws=${ws.slice(0, 8)} delete threw; `;
    }
  }
  for (const n of Object.keys(users)) {
    try {
      await admin.auth.admin.deleteUser(users[n].id);
    } catch { /* best-effort */ }
  }
  await intakeSql.end().catch(() => undefined);
  await superSql.end().catch(() => undefined);
}
console.log(`cleanup: ${deletionNote}`);
console.log(failed === 0 ? "LIVE WORKFLOW VERIFICATION: ALL GATES PASS" : `LIVE WORKFLOW VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
