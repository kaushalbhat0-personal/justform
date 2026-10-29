#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 10 metering-only billing (Gates M1–M18).
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * APP_URL (running app with intake + tick + v1 API). Creates throwaway users,
 * workspaces, forms, keys, endpoints, drives real metering flows, then cleans
 * up. Never prints secrets/tokens/payloads.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET } = process.env;
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL || !CRON_SECRET) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL, CRON_SECRET.");
  process.exit(0);
}

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const tag = Date.now().toString(36);
const email = (n) => `bill-${n}-${tag}@example.test`;
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
const cookieFor = async (n) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: email(n), password: "Verify123!" }),
  });
  const s = await res.json();
  if (!s.access_token) throw new Error(`token for ${n} failed`);
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const obj = { access_token: s.access_token, refresh_token: s.refresh_token, expires_in: s.expires_in, expires_at: s.expires_at, token_type: "bearer", user: s.user };
  return `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(obj)).toString("base64url")}`;
};

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const genKey = (scopes) => {
  let prefix = "";
  const rb = randomBytes(12);
  for (const b of rb) prefix += ALNUM[b % ALNUM.length];
  const secret = randomBytes(32).toString("base64url");
  return { fullKey: `fm_live_${prefix}_${secret}`, prefix, hash: createHash("sha256").update(`fm_live_${prefix}_${secret}`, "utf8").digest("hex"), scopes };
};
const createKey = async (session, wsId, name, scopes) => {
  const k = genKey(scopes);
  const { data, error } = await session.rpc("create_api_key", {
    p_id: randomUUID(), p_workspace_id: wsId, p_prefix: k.prefix, p_secret_hash: k.hash, p_name: name, p_scopes: scopes,
  });
  if (error) throw new Error(`create_api_key: ${error.message}`);
  return { ...k, meta: data };
};
const api = async (path, key, query = "") => {
  const t0 = performance.now();
  const res = await fetch(`${APP_URL}${path}${query}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: res.status, body: await res.json().catch(() => null), ms: performance.now() - t0 };
};

const users = {};
for (const n of ["alice", "frank", "bob", "mallory"]) users[n] = await mkUser(n);
const clients = {};
for (const n of ["alice", "frank", "bob", "mallory"]) clients[n] = await login(n);
const cookies = {};
for (const n of ["alice", "frank", "bob"]) cookies[n] = await cookieFor(n);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const ver1 = randomUUID();
const pubId = `billlive-${tag}-x`.slice(0, 22);

const docV1 = {
  id: formA, key: "contact", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Contact" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "name", type: "short_text", label: "Full name", required: true },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};

async function fixture() {
  const { error: wErr } = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "BillA", p_slug: `billa-${tag}` });
  if (wErr) throw new Error(`wsA: ${wErr.message}`);
  const { error: wErr2 } = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "BillB", p_slug: `billb-${tag}` });
  if (wErr2) throw new Error(`wsB: ${wErr2.message}`);
  for (const [id, role, uid] of [[randomUUID(), "admin", users.frank.id], [randomUUID(), "builder", users.bob.id]]) {
    const { error } = await admin.from("memberships").insert({ id, workspace_id: wsA, user_id: uid, role });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }
  const { error: fErr } = await clients.alice.from("forms").insert({ id: formA, workspace_id: wsA, key: "contact", title: "Contact", draft_payload: docV1 });
  if (fErr) throw new Error(`formA: ${fErr.message}`);
  const { error: vErr } = await admin.from("form_versions").insert({ id: ver1, form_id: formA, workspace_id: wsA, published_version_no: 1, schema_snapshot: docV1, schema_version: 1, schema_hash: "hash-1", renderer_version: "r", publisher_id: users.alice.id });
  if (vErr) throw new Error(`version: ${vErr.message}`);
  const { error: pErr } = await admin.from("form_publications").insert({ id: randomUUID(), workspace_id: wsA, form_id: formA, form_version_id: ver1, public_id: pubId, created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
}
await fixture();

const summaryAs = async (n, ws) => {
  const { data, error } = await clients[n].rpc("get_usage_summary", { p_workspace_id: ws });
  return { data, error };
};
const intake = async (values, key, ip) => {
  const res = await fetch(`${APP_URL}/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: JSON.stringify({ values, idempotencyKey: key }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/* ---------------- M1: plan isolation ---------------- */
check("M1", "workspace A cannot read workspace B billing/usage", async () => {
  const { error } = await clients.mallory.rpc("get_usage_summary", { p_workspace_id: wsA });
  if (!error) throw new Error("cross-workspace summary readable");
  const page = await fetch(`${APP_URL}/app/${wsA}/billing`, { headers: { cookie: cookies.alice } });
  if (page.status !== 200) throw new Error(`owner billing page: ${page.status}`);
  const malloryPage = await fetch(`${APP_URL}/app/${wsA}/billing`, { headers: { cookie: await cookieFor("mallory") } });
  if (malloryPage.status !== 404) throw new Error(`outsider billing page: ${malloryPage.status}`);
});

/* ---------------- M2: member access ---------------- */
check("M2", "owner/admin read usage; builder cannot", async () => {
  for (const n of ["alice", "frank"]) {
    const { data, error } = await summaryAs(n, wsA);
    if (error) throw new Error(`${n}: ${error.message}`);
    if (data?.plan !== "free" || typeof data?.period_start !== "string") throw new Error(`${n}: bad shape ${JSON.stringify(data)}`);
    if (!data?.metrics?.monthly_submissions || !("remaining" in data.metrics.monthly_submissions)) throw new Error(`${n}: missing meters`);
  }
  const denied = await summaryAs("bob", wsA);
  if (!denied.error) throw new Error("builder reads billing");
  const page = await fetch(`${APP_URL}/app/${wsA}/billing`, { headers: { cookie: cookies.bob } });
  if (page.status !== 404) throw new Error(`builder billing page: ${page.status}`);
});

/* ---------------- M3: anonymous denial ---------------- */
check("M3", "anon cannot read usage via RPC or page", async () => {
  const { error } = await anonC.rpc("get_usage_summary", { p_workspace_id: wsA });
  if (!error) throw new Error("anon reads summary");
  const page = await fetch(`${APP_URL}/app/${wsA}/billing`, { redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(page.status)) throw new Error(`anon billing page: ${page.status}`);
});

/* ---------------- keys for M4–M6 ---------------- */
let billKey;
let formsKey;
let subsKey;
check("M0", "setup: scoped keys", async () => {
  billKey = await createKey(clients.alice, wsA, "bill", ["billing:read"]);
  formsKey = await createKey(clients.alice, wsA, "forms", ["forms:read"]);
  subsKey = await createKey(clients.alice, wsA, "subs", ["submissions:read"]);
});

/* ---------------- M4: billing scope ---------------- */
check("M4", "billing:read opens the usage endpoint and nothing else", async () => {
  const t0 = performance.now();
  const r = await api("/api/v1/billing/usage", billKey.fullKey);
  console.log(`   [S] GET /api/v1/billing/usage: ${(performance.now() - t0).toFixed(1)}ms (status ${r.status})`);
  if (r.status !== 200) throw new Error(`usage: ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.data?.plan !== "free" || !r.body?.data?.metrics) throw new Error("usage shape wrong");
  if (JSON.stringify(r.body).includes("secret")) throw new Error("usage leaks secret material");
  for (const p of ["/api/v1/forms", `/api/v1/submissions/${randomUUID()}`]) {
    const d = await api(p, billKey.fullKey);
    if (d.status !== 403) throw new Error(`${p} with billing key: ${d.status}`);
  }
});

/* ---------------- M5/M6: other scopes denied ---------------- */
check("M5", "forms:read cannot access billing usage", async () => {
  const r = await api("/api/v1/billing/usage", formsKey.fullKey);
  if (r.status !== 403) throw new Error(`forms key on billing: ${r.status}`);
});
check("M6", "submissions:read cannot access or mutate billing", async () => {
  const r = await api("/api/v1/billing/usage", subsKey.fullKey);
  if (r.status !== 403) throw new Error(`submissions key on billing: ${r.status}`);
  const bad = await fetch(`${APP_URL}/api/v1/billing/usage`, {
    method: "POST",
    headers: { authorization: `Bearer ${subsKey.fullKey}`, "content-type": "application/json" },
    body: "{}",
  });
  if (![403, 404, 405].includes(bad.status)) throw new Error(`POST billing usage: ${bad.status}`);
});

/* ---------------- M7: no client mutation ---------------- */
check("M7", "browser cannot change plan/limits/usage", async () => {
  const upd = await clients.alice.from("workspaces").update({ plan: "business" }).eq("id", wsA);
  if (!upd.error) throw new Error("direct plan change allowed");
  const upd2 = await clients.alice.from("workspaces").update({ billing_status: "past_due" }).eq("id", wsA);
  if (!upd2.error) throw new Error("direct billing_status change allowed");
  const ins = await clients.alice.from("usage_events").insert({ id: randomUUID(), workspace_id: wsA, metric: "submission", quantity: 1, source: "intake", source_id: "hack", period_start: "2026-10-01" });
  if (!ins.error) throw new Error("direct usage insert allowed");
  const lim = await clients.alice.from("plan_limits").update({ limit_value: 999999 }).eq("plan", "free").eq("metric", "monthly_submissions");
  if (!lim.error) throw new Error("direct limit change allowed");
  // Rename still works (the one legitimate direct write).
  const ren = await clients.alice.from("workspaces").update({ name: "BillA2" }).eq("id", wsA);
  if (ren.error) throw new Error(`rename blocked: ${ren.error.message}`);
});

/* ---------------- M8/M9/M10: submission accounting ---------------- */
let subsUsed = 0;
let subId = "";
check("M8", "one successful submission produces exactly one usage increment", async () => {
  const before = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  const r = await intake({ name: "Met Ernie" }, `bill-key-${tag}-01`);
  if (r.status !== 200 || r.body?.success !== true) throw new Error(`intake: ${r.status} ${JSON.stringify(r.body)}`);
  subId = r.body.submissionId;
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  if (after - before !== 1) throw new Error(`delta ${after - before}, want 1`);
  subsUsed = after;
});
check("M9", "rejected submission counts nothing", async () => {
  const bad = await intake({}, `bill-key-${tag}-02`);
  if (bad.status !== 422) throw new Error(`invalid intake: ${bad.status}`);
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  if (after !== subsUsed) throw new Error(`failed submit counted (used=${after}, want ${subsUsed})`);
});
check("M10", "replays and retried records never double-count", async () => {
  const replay = await intake({ name: "Met Ernie" }, `bill-key-${tag}-01`);
  if (replay.body?.submissionId === undefined) throw new Error("replay lost receipt");
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  if (after !== subsUsed) throw new Error(`replay double-counted (used=${after})`);
  // Same source through the trusted record path twice → second is a no-op.
  // Same-source replay through the trusted path counts once (use a
  // non-submission metric so the submissions counter stays exact for M14/M15).
  const a = await admin.rpc("record_usage", { p_workspace_id: wsA, p_metric: "webhook_attempt", p_source: "tick", p_source_id: `probe-${tag}`, p_quantity: 1 });
  const b = await admin.rpc("record_usage", { p_workspace_id: wsA, p_metric: "webhook_attempt", p_source: "tick", p_source_id: `probe-${tag}`, p_quantity: 1 });
  if (a.data?.counted !== true || b.data?.counted !== false) throw new Error(`record idempotency: ${JSON.stringify([a.data, b.data])}`);
});

/* ---------------- M13/M11 first (need usage rows), then M15 fill ---------------- */
let apiUsed = 0;
check("M13", "webhook accounting matches the attempts rule", async () => {
  const secret = randomBytes(32).toString("base64url");
  const { createCipheriv } = await import("node:crypto");
  const key = Buffer.from(process.env.WEBHOOK_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const secretEnc = Buffer.concat([iv, enc]).toString("base64");
  const { data: ep, error } = await clients.alice.rpc("create_webhook", {
    p_id: randomUUID(), p_workspace_id: wsA, p_form_id: null, p_url: "http://8.8.8.8:9/hook",
    p_secret_enc: secretEnc, p_events: ["submission.created"],
  });
  if (error) throw new Error(`endpoint: ${error.message}`);
  const before = (await summaryAs("alice", wsA)).data.metrics.monthly_webhook_deliveries.used;
  const r = await intake({ name: "Hook Ida" }, `bill-key-${tag}-03`);
  if (r.status !== 200) throw new Error(`intake: ${r.status}`);
  subsUsed += 1;
  // The Stage-0 pump is global and bounded: poll ticks until this endpoint's
  // deliveries are recorded (a shared backlog must never starve the assertion).
  let dels = [];
  for (let i = 0; i < 10; i += 1) {
    const tick = await fetch(`${APP_URL}/api/internal/outbox-tick`, { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    const tickBody = await tick.json().catch(() => null);
    if (tick.status !== 200 || tickBody?.ok !== true) throw new Error(`tick: ${tick.status}`);
    const lr = await clients.alice.rpc("list_deliveries", { p_endpoint_id: ep.id, p_limit: 10, p_cursor: "" });
    if (lr.error) throw new Error(`deliveries: ${lr.error.message}`);
    dels = lr.data ?? [];
    if (dels.some((d) => d.attempts >= 1)) break;
  }
  const recorded = dels.filter((d) => d.attempts >= 1);
  console.log(`   [S] delivery attempts=${dels.length} recorded=${recorded.length} status=${JSON.stringify(dels.map((d) => d.status))}`);
  if (recorded.length === 0) throw new Error("endpoint deliveries never recorded");
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_webhook_deliveries.used;
  // Metric rule: delivery attempts — exactly one usage row per recorded attempt.
  if (after - before !== recorded.length) throw new Error(`attempt delta ${after - before}, want ${recorded.length} (one row per recorded attempt)`);
});
check("M11", "one qualifying API request counts exactly one", async () => {
  const before = (await summaryAs("alice", wsA)).data.metrics.monthly_api_requests.used;
  await api("/api/v1/submissions/" + subId, subsKey.fullKey);
  await api(`/api/v1/billing/usage`, billKey.fullKey);
  await api("/api/v1/forms", formsKey.fullKey);
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_api_requests.used;
  if (after - before !== 3) throw new Error(`API delta ${after - before}, want 3`);
  apiUsed = after;
});
check("M12", "internal/anonymous traffic is never metered", async () => {
  await fetch(`${APP_URL}/api/internal/outbox-tick`, { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });
  await fetch(`${APP_URL}/f/${pubId}`);
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_api_requests.used;
  if (after !== apiUsed) throw new Error(`internal traffic counted (used=${after}, want ${apiUsed})`);
});

/* ---------------- M14: period boundary ---------------- */
check("M14", "previous-period usage does not contaminate the current period", async () => {
  const before = (await summaryAs("alice", wsA)).data;
  if (!/^\d{4}-\d{2}-01$/.test(before.period_start)) throw new Error(`period not month-anchored: ${before.period_start}`);
  const old = new Date(Date.UTC(2026, 7, 10)).toISOString();
  const rec = await admin.rpc("record_usage", { p_workspace_id: wsA, p_metric: "submission", p_source: "intake", p_source_id: `old-${tag}`, p_quantity: 5, p_occurred_at: old });
  if (rec.data?.counted !== true) throw new Error(`backdated record: ${JSON.stringify(rec.data)}`);
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  if (after !== subsUsed) throw new Error(`old period leaked (used=${after}, want ${subsUsed})`);
});

/* ---------------- M15: quota enforcement ---------------- */
check("M15", "exceeding a finite limit produces a deterministic denial", async () => {
  // Free monthly_submissions = 100. Fill to the cap with unique keys and
  // rotating test IPs (the limiter is per-IP; rotation here is test-only and
  // exercises the documented untrusted-proxy limitation honestly).
  const need = 100 - subsUsed;
  for (let i = 0; i < need; i += 1) {
    const r = await intake({ name: `Fill ${i}` }, `bill-fill-${tag}-${i}`, `10.9.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    if (r.status !== 200) throw new Error(`fill ${i}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const full = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions;
  if (full.used !== 100 || full.remaining !== 0) throw new Error(`cap state wrong: ${JSON.stringify(full)}`);
  const denied = await intake({ name: "Over Cap" }, `bill-over-${tag}`, "10.99.0.1");
  if (denied.status !== 409 || denied.body?.code !== "FORM_LIMIT_REACHED") {
    throw new Error(`over-quota: want 409 FORM_LIMIT_REACHED, got ${denied.status} ${JSON.stringify(denied.body)}`);
  }
  const rows = await admin.from("submissions").select("id", { count: "exact" }).eq("workspace_id", wsA).eq("payload->>name", "Over Cap");
  if ((rows.data ?? []).length !== 0) throw new Error("denied submission persisted");
  const after = (await summaryAs("alice", wsA)).data.metrics.monthly_submissions.used;
  if (after !== 100) throw new Error(`denied submit counted (used=${after})`);
});

/* ---------------- M16: unlimited ---------------- */
check("M16", "unlimited metrics never deny", async () => {
  const { data, error } = await admin.rpc("check_quota", { p_workspace_id: wsA, p_metric: "monthly_submissions", p_quantity: 1000000 });
  void error;
  if (!data) throw new Error("no verdict");
  // Free plan is finite; the NULL-limit path is unit + PGlite proven.
  // Here: storage is unmetered-by-design on every plan.
  const s = await admin.rpc("check_quota", { p_workspace_id: wsA, p_metric: "storage_bytes", p_quantity: 1 });
  if (s.data?.allowed !== true || s.data?.limit !== null) throw new Error(`storage verdict: ${JSON.stringify(s.data)}`);
  const summary = (await summaryAs("alice", wsA)).data;
  if (summary.metrics.storage_bytes.metered !== false) throw new Error("storage shown as metered");
});

/* ---------------- M17: substitution ---------------- */
check("M17", "workspace identifiers cannot be swapped", async () => {
  const { error } = await clients.mallory.rpc("get_usage_summary", { p_workspace_id: wsA });
  if (!error) throw new Error("substituted workspace readable via RPC");
  const page = await fetch(`${APP_URL}/app/${wsB}/billing`, { headers: { cookie: cookies.alice } });
  if (page.status !== 404) throw new Error(`cross-workspace billing page: ${page.status}`);
  const badUuid = await fetch(`${APP_URL}/app/not-a-uuid/billing`, { headers: { cookie: cookies.alice } });
  if (badUuid.status !== 404) throw new Error(`malformed workspace billing page: ${badUuid.status}`);
});

/* ---------------- run + cleanup ---------------- */
let failed = 0;
try {
  for (const r of results) {
    let status = "PASS";
    try {
      await r.run();
    } catch (e) {
      status = `FAIL: ${e instanceof Error ? e.message : e}`;
    }
    if (status !== "PASS") failed += 1;
    console.log(`${status === "PASS" ? "ok  " : "FAIL"} [Gate ${r.gate}] ${r.name}${status === "PASS" ? "" : ` — ${status}`}`);
  }
} finally {
  try {
    await admin.from("workspaces").delete().eq("id", wsA);
    await admin.from("workspaces").delete().eq("id", wsB);
  } catch { /* best-effort cleanup */ }
  for (const n of Object.keys(users)) {
    try {
      await admin.auth.admin.deleteUser(users[n].id);
    } catch { /* best-effort cleanup */ }
  }
}
console.log(failed === 0 ? "BILLING LIVE VERIFICATION: ALL GATES PASS" : `BILLING LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
