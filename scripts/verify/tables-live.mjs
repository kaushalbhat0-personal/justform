#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 8 Tables v1 (Gates T1–T14).
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * APP_URL (reachable app with the tables route + temp int-test route),
 * CRON_SECRET. Creates throwaway users + workspaces + form + versions +
 * submissions, then cleans up. Never prints secrets/tokens.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
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
const email = (n) => `tables-${n}-${tag}@example.test`;
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
const asTempRoute = async (cookie, body) => {
  const res = await fetch(`${APP_URL}/api/int-test/tables`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-verify-secret": CRON_SECRET, cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const users = {};
for (const n of ["alice", "bob", "cara", "dave", "mallory", "frank"]) users[n] = await mkUser(n);
const clients = {};
for (const n of ["alice", "bob", "cara", "dave", "mallory", "frank"]) clients[n] = await login(n);
const cookies = {};
for (const n of ["alice", "bob", "cara", "dave", "frank"]) cookies[n] = await cookieFor(n);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const ver1 = randomUUID();
const ver2 = randomUUID();
const ver3 = randomUUID();
const pub = randomUUID();

// v1: Full name + Topic. v2: renamed name label, topic REMOVED, Age added.
// v3: adds Notes (long text), keeps the rest — three-version mixed dataset.
const docV1 = {
  id: formA, key: "contact", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Contact" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "name", type: "short_text", label: "Full name", required: true },
    { id: randomUUID(), key: "topic", type: "dropdown", label: "Topic", required: false, config: { options: [{ value: "support", label: "Support" }, { value: "sales", label: "Sales" }] } },
    { id: randomUUID(), key: "email", type: "email", label: "Email", required: false },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};
const docV2 = JSON.parse(JSON.stringify(docV1));
docV2.pages[0].sections[0].fields.find((f) => f.key === "name").label = "Your full name";
docV2.pages[0].sections[0].fields = docV2.pages[0].sections[0].fields.filter((f) => f.key !== "topic");
docV2.pages[0].sections[0].fields.push({ id: randomUUID(), key: "age", type: "number", label: "Age", required: false });
const docV3 = JSON.parse(JSON.stringify(docV2));
docV3.pages[0].sections[0].fields.push({ id: randomUUID(), key: "notes", type: "long_text", label: "Notes", required: false });

const subIds = [];
const payloads = [];
// 30 submissions across 3 versions: v1 ×10, v2 ×10, v3 ×10.
for (let i = 0; i < 30; i += 1) {
  const ver = i < 10 ? 1 : i < 20 ? 2 : 3;
  const id = randomUUID();
  subIds.push(id);
  const base = { name: `Person ${String(i).padStart(2, "0")}` };
  if (ver === 1) {
    base.topic = i % 2 === 0 ? "support" : "sales";
    if (i % 3 === 0) base.email = `person${i}@example.test`;
  } else if (ver === 2) {
    if (i % 2 === 0) base.age = 20 + i;
  } else {
    if (i % 2 === 0) base.notes = `note for ${i} `.repeat(10);
  }
  payloads.push({ id, ver, payload: base, submittedAt: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:${String(i % 60).padStart(2, "0")}:00Z` });
}

async function fixture() {
  const { error: wErr } = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "TablesA", p_slug: `tablesa-${tag}` });
  if (wErr) throw new Error(`wsA: ${wErr.message}`);
  const { error: wErr2 } = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "TablesB", p_slug: `tablesb-${tag}` });
  if (wErr2) throw new Error(`wsB: ${wErr2.message}`);
  for (const [id, role, uid] of [
    [randomUUID(), "builder", users.bob.id],
    [randomUUID(), "data_collaborator", users.cara.id],
    [randomUUID(), "viewer", users.dave.id],
    [randomUUID(), "admin", users.frank.id],
  ]) {
    const { error } = await admin.from("memberships").insert({ id, workspace_id: wsA, user_id: uid, role });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }
  const { error: fErr } = await clients.alice.from("forms").insert({ id: formA, workspace_id: wsA, key: "contact", title: "Contact", draft_payload: docV1 });
  if (fErr) throw new Error(`form: ${fErr.message}`);
  for (const [vid, no, doc] of [[ver1, 1, docV1], [ver2, 2, docV2], [ver3, 3, docV3]]) {
    const { error } = await admin.from("form_versions").insert({ id: vid, form_id: formA, workspace_id: wsA, published_version_no: no, schema_snapshot: doc, schema_version: 1, schema_hash: `hash-${no}`, renderer_version: "r", publisher_id: users.alice.id });
    if (error) throw new Error(`version ${no}: ${error.message}`);
  }
  const vers = { 1: ver1, 2: ver2, 3: ver3 };
  const { error: pErr } = await admin.from("form_publications").insert({ id: pub, workspace_id: wsA, form_id: formA, form_version_id: ver3, public_id: `tables-live-${tag}`.slice(0, 22), created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
  for (const [i, s] of payloads.entries()) {
    const { error } = await admin.from("submissions").insert({ id: s.id, workspace_id: wsA, form_id: formA, publication_id: pub, form_version_id: vers[s.ver], payload: s.payload, idempotency_key: `live-tables-${tag}-${i}`, submitted_at: s.submittedAt, status: i % 7 === 0 ? "archived" : "new" });
    if (error) throw new Error(`submission ${i}: ${error.message}`);
  }
}
await fixture();

const tableUrl = (extra = "") => `${APP_URL}/app/${wsA}/forms/${formA}/tables${extra}`;

/* ---------------- T1–T3: permitted roles read ---------------- */
for (const [gate, name, user] of [["T1", "owner reads table data", "alice"], ["T2", "admin reads table data", "frank"], ["T3", "builder reads table data", "bob"]]) {
  check(gate, name, async () => {
    const res = await asTempRoute(cookies[user], { op: "list", workspaceId: wsA, formId: formA, limit: 20 });
    if (res.status !== 200 || !res.body?.ok) throw new Error(`list failed: ${res.status} ${JSON.stringify(res.body)}`);
    if (res.body.page.total !== 30) throw new Error(`total ${res.body.page.total}, want 30`);
    if (res.body.page.rows.length !== 20 || !res.body.page.nextCursor) throw new Error("page 1 malformed");
    const snaps = await asTempRoute(cookies[user], { op: "snapshots", workspaceId: wsA, formId: formA, versionIds: [...new Set(res.body.page.rows.map((r) => r.formVersionId))] });
    if (snaps.status !== 200 || !snaps.body?.ok) throw new Error("snapshots failed");
    const page = await fetch(tableUrl(), { headers: { cookie: cookies[user] } });
    const html = await page.text();
    if (page.status !== 200) throw new Error(`tables page status ${page.status}`);
    // Page 1 shows the 20 newest rows: assert on the actual first row summary.
    const firstPrimary = res.body.page.rows[0]?.summary?.primary;
    if (typeof firstPrimary !== "string" || !html.includes(firstPrimary)) {
      throw new Error("tables page missing first-row value");
    }
    for (const needle of ["Responses table", "Your full name", "Topic", "Age", "Notes", "Open →"]) {
      if (!html.includes(needle)) throw new Error(`tables page missing ${JSON.stringify(needle)}`);
    }
    if (/workspace_id|draft_payload|service_role/i.test(html)) throw new Error("tables page leaks internals");
  });
}

/* ---------------- T4–T5: data_collaborator / viewer denied ---------------- */
check("T4", "data collaborator cannot read table data", async () => {
  const res = await asTempRoute(cookies.cara, { op: "list", workspaceId: wsA, formId: formA, limit: 20 });
  if (res.status !== 404) throw new Error(`data_collaborator list status ${res.status}`);
  const page = await fetch(tableUrl(), { headers: { cookie: cookies.cara } });
  if (page.status !== 404) throw new Error(`data_collaborator page status ${page.status}`);
  const direct = await clients.cara.from("submissions").select("id").eq("workspace_id", wsA);
  if ((direct.data ?? []).length !== 0) throw new Error("data_collaborator reads submissions");
});
check("T5", "viewer receives zero submission data", async () => {
  const page = await fetch(tableUrl(), { headers: { cookie: cookies.dave } });
  if (page.status !== 404) throw new Error(`viewer page status ${page.status}`);
  const direct = await clients.dave.from("submissions").select("id").eq("workspace_id", wsA);
  if ((direct.data ?? []).length !== 0) throw new Error("viewer reads submissions");
});

/* ---------------- T6: stranger workspace ---------------- */
check("T6", "cross-workspace table access returns zero/denied", async () => {
  const seen = await clients.mallory.from("submissions").select("id").eq("workspace_id", wsA);
  if ((seen.data ?? []).length !== 0) throw new Error("cross-workspace read allowed");
  const res = await fetch(`${APP_URL}/app/${wsB}/forms/${formA}/tables`, { headers: { cookie: cookies.alice } });
  if (res.status !== 404) throw new Error(`cross-workspace tables status ${res.status}`);
});

/* ---------------- T7: anonymous ---------------- */
check("T7", "anonymous cannot access Tables", async () => {
  const res = await fetch(tableUrl(), { redirect: "manual" });
  if (![301, 302, 303, 307, 308].includes(res.status)) throw new Error(`anon tables status ${res.status}`);
  if (!String(res.headers.get("location") ?? "").includes("/login")) throw new Error("anon not sent to login");
  const { data, error } = await anonC.from("submissions").select("id");
  if (!error || (data ?? []).length !== 0) throw new Error("anon reads submissions");
});

/* ---------------- T8: URL substitution ---------------- */
check("T8", "workspace/form substitution is denied", async () => {
  const r1 = await fetch(`${APP_URL}/app/${wsB}/forms/${formA}/tables`, { headers: { cookie: cookies.alice } });
  if (r1.status !== 404) throw new Error(`ws-substituted tables status ${r1.status}`);
  const otherForm = randomUUID();
  const r2 = await fetch(`${APP_URL}/app/${wsA}/forms/${otherForm}/tables`, { headers: { cookie: cookies.alice } });
  if (r2.status !== 404) throw new Error(`form-substituted tables status ${r2.status}`);
  const badId = await fetch(`${APP_URL}/app/${wsA}/forms/not-a-uuid/tables`, { headers: { cookie: cookies.alice } });
  if (badId.status !== 404) throw new Error(`malformed form id status ${badId.status}`);
});

/* ---------------- T9: pagination bound ---------------- */
check("T9", "page size is bounded; keyset pages are complete", async () => {
  const big = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 500 });
  if ((big.body?.page?.rows?.length ?? 0) > 100) throw new Error("page size not bounded");
  const seen = new Set();
  let cursor;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > 10) throw new Error("pagination did not terminate");
    const r = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 10, ...(cursor ? { cursor } : {}) });
    if (r.status !== 200 || !r.body?.ok) throw new Error(`page ${pages} failed`);
    for (const row of r.body.page.rows) seen.add(row.id);
    if (!r.body.page.nextCursor) break;
    cursor = r.body.page.nextCursor;
  }
  if (seen.size !== 30) throw new Error(`paginated ${seen.size} rows, want 30`);
  if (pages !== 3) throw new Error(`want 3 pages, got ${pages}`);
});

/* ---------------- T10: cursor tampering ---------------- */
check("T10", "invalid/forged cursors fail safely", async () => {
  for (const bad of ["!!!", "aW52YWxpZA", Buffer.from(JSON.stringify({ t: "x", id: "y" })).toString("base64url"), Buffer.from(JSON.stringify({ t: "2026-10-20T10:00:00.000Z", id: "not-a-uuid" })).toString("base64url")]) {
    const r = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 10, cursor: bad });
    if (r.status !== 404) throw new Error(`bad cursor accepted: ${JSON.stringify(bad)} → ${r.status}`);
  }
  const page = await fetch(tableUrl("?cursor=!!!"), { headers: { cookie: cookies.alice } });
  if (page.status !== 404) throw new Error(`bad cursor page status ${page.status}`);
});

/* ---------------- T11: search abuse ---------------- */
check("T11", "search syntax cannot break query structure or leak errors", async () => {
  for (const q of ["a,b(c)d", "100%_x\\y", "*", "%", "<script>alert(1)</script>", "workspace_id", "'; DROP TABLE--"]) {
    const r = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { q }, limit: 5 });
    if (r.status !== 200 || !r.body?.ok) throw new Error(`search ${JSON.stringify(q)} → ${r.status} ${JSON.stringify(r.body)}`);
    const blob = JSON.stringify(r.body);
    if (/permission denied|syntax error|postgrest|PGRST/i.test(blob)) throw new Error(`search leaked internals for ${JSON.stringify(q)}`);
  }
});

/* ---------------- T12: payload privacy ---------------- */
check("T12", "no submission values in audit, URLs, or error output", async () => {
  // Mutate one row so an audit event exists, then verify metadata-only content.
  await clients.alice.rpc("set_submission_status", { p_submission_id: payloads[0].id, p_status: "archived" });
  const rows = await admin.from("audit_log").select("action,diff").eq("workspace_id", wsA).eq("resource_type", "submission").order("created_at", { ascending: false }).limit(5);
  const blob = JSON.stringify(rows.data);
  for (const secret of ["Person 00", "person0@example.test", "note for"]) {
    if (blob.includes(secret)) throw new Error("respondent payload leaked into audit");
  }
  // Unknown status filter is ignored safely (same semantics as inbox), never errors or leaks.
  const page = await fetch(tableUrl("?status=bogus"), { headers: { cookie: cookies.alice } });
  if (page.status !== 200) throw new Error(`bad status page status ${page.status}`);
  // Opaque pagination cursors legitimately live in ?cursor= links (same exposure
  // as detail URLs, which already carry row ids); strip them before scanning.
  const html = await fetch(tableUrl(), { headers: { cookie: cookies.alice } }).then((r) => r.text());
  const htmlNoCursor = html.replace(/cursor=[A-Za-z0-9_-]+/g, "cursor=…");
  if (/[A-Za-z0-9+/]{40,}={0,2}/.test(htmlNoCursor.replace(/Person \d\d/g, "")) && /eyJ/.test(htmlNoCursor)) {
    throw new Error("token-like material in tables HTML");
  }
  const err = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: "not-a-uuid", limit: 5 });
  if (err.status !== 404 || /payload|Person/i.test(JSON.stringify(err.body))) throw new Error("error path leaks data");
});

/* ---------------- T13: historical version ---------------- */
check("T13", "v1 submission keeps v1 semantics after v2/v3 publication", async () => {
  const res = await asTempRoute(cookies.alice, { op: "snapshots", workspaceId: wsA, formId: formA, versionIds: [ver1, ver2, ver3] });
  if (res.status !== 200 || !res.body?.ok) throw new Error("snapshots failed");
  const byNo = Object.fromEntries(res.body.snapshots.map((s) => [s.publishedVersionNo, s.snapshot]));
  const v1Labels = byNo[1].pages[0].sections[0].fields.map((f) => f.label);
  if (!v1Labels.includes("Full name") || v1Labels.includes("Your full name")) throw new Error(`v1 labels wrong: ${v1Labels.join("|")}`);
  if (!byNo[1].pages[0].sections[0].fields.some((f) => f.key === "topic")) throw new Error("v1 lost topic");
  if (byNo[2].pages[0].sections[0].fields.some((f) => f.key === "topic")) throw new Error("v2 should not have topic");
  if (!byNo[2].pages[0].sections[0].fields.some((f) => f.key === "age")) throw new Error("v2 missing age");
  // List rows stay pinned: v1 row references ver1, v2 row ver2, v3 row ver3.
  const all = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 100 });
  const byId = Object.fromEntries(all.body.page.rows.map((r) => [r.id, r]));
  const v1Row = payloads.find((p) => p.ver === 1);
  if (byId[v1Row.id]?.formVersionId !== ver1) throw new Error("v1 row repinned");
  if (byId[v1Row.id]?.summary?.primary !== v1Row.payload.name) throw new Error("v1 summary wrong");
  // Tables page shows v1-only Topic column with v1 values, and the v2 Age column.
  const html = await fetch(tableUrl(), { headers: { cookie: cookies.alice } }).then((r) => r.text());
  for (const needle of ["Your full name", "Topic", "Age", "Notes", "Support"]) {
    if (!html.includes(needle)) throw new Error(`tables page missing ${needle}`);
  }
  // v1 dropdown value renders with its pinned v1 label, not raw.
  if (!html.includes("Support")) throw new Error("pinned option label missing");
});

/* ---------------- T14: bounded query behavior ---------------- */
check("T14", "representative 3-version load stays bounded with pinned versions", async () => {
  const t0 = performance.now();
  const seen = new Map();
  let cursor;
  for (;;) {
    const r = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 10, ...(cursor ? { cursor } : {}) });
    if (r.status !== 200 || !r.body?.ok) throw new Error("paged load failed");
    for (const row of r.body.page.rows) seen.set(row.id, row.formVersionId);
    if (!r.body.page.nextCursor) break;
    cursor = r.body.page.nextCursor;
  }
  const dt = performance.now() - t0;
  console.log(`   [S] 30 rows / 3 versions paged load: ${dt.toFixed(1)}ms`);
  if (seen.size !== 30) throw new Error(`loaded ${seen.size} rows, want 30`);
  const vers = new Set(seen.values());
  if (vers.size !== 3) throw new Error(`rows span ${vers.size} versions, want 3`);
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
console.log(failed === 0 ? "TABLES LIVE VERIFICATION: ALL GATES PASS" : `TABLES LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
