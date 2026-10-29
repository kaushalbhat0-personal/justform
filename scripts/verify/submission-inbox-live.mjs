#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 7 submission inbox (Gates B1–B8).
 * Requires migration 0007 applied (`supabase db push`) plus:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   APP_URL (reachable app for page-level gates), CRON_SECRET (temp route).
 * Creates throwaway users + workspace + form + versions + submissions, then
 * cleans up (workspace cascade + users). Never prints secrets/tokens.
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
const email = (n) => `inbox-${n}-${tag}@example.test`;
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
// Session cookie in @supabase/ssr chunk format (base64- + base64url session JSON).
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
  const res = await fetch(`${APP_URL}/api/int-test/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-verify-secret": CRON_SECRET, cookie },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const users = {};
for (const n of ["alice", "bob", "cara", "dave", "mallory"]) users[n] = await mkUser(n);
const clients = {};
for (const n of ["alice", "bob", "cara", "dave", "mallory"]) clients[n] = await login(n);
const cookies = {};
for (const n of ["alice", "bob", "cara", "dave"]) cookies[n] = await cookieFor(n);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const ver1 = randomUUID();
const ver2 = randomUUID();
const pub = randomUUID();
const subIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

const docV1 = {
  id: formA, key: "contact", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Contact" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "name", type: "short_text", label: "Full name", required: true },
    { id: randomUUID(), key: "topic", type: "dropdown", label: "Topic", required: false, config: { options: [{ value: "support", label: "Support" }, { value: "sales", label: "Sales" }] } },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};
const docV2 = JSON.parse(JSON.stringify(docV1));
docV2.pages[0].sections[0].fields[0].label = "Your full name";
docV2.pages[0].sections[0].fields.push({ id: randomUUID(), key: "email", type: "email", label: "Email", required: false });

const payloads = [
  { name: "Ann Alpha", topic: "support" },
  { name: "Bo Beta", topic: "sales" },
  { name: "Cy Gamma", topic: "support", email: "cy@example.test" },
  { name: "De Delta", topic: "sales", email: "de@example.test" },
];

async function fixture() {
  const { error: wErr } = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "InboxA", p_slug: `inboxa-${tag}` });
  if (wErr) throw new Error(`wsA: ${wErr.message}`);
  const { error: wErr2 } = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "InboxB", p_slug: `inboxb-${tag}` });
  if (wErr2) throw new Error(`wsB: ${wErr2.message}`);
  for (const [id, role, uid] of [[randomUUID(), "builder", users.bob.id], [randomUUID(), "data_collaborator", users.cara.id], [randomUUID(), "viewer", users.dave.id]]) {
    const { error } = await admin.from("memberships").insert({ id, workspace_id: wsA, user_id: uid, role });
    if (error) throw new Error(`membership ${role}: ${error.message}`);
  }
  const { error: fErr } = await clients.alice.from("forms").insert({ id: formA, workspace_id: wsA, key: "contact", title: "Contact", draft_payload: docV1 });
  if (fErr) throw new Error(`form: ${fErr.message}`);
  for (const [vid, no, doc] of [[ver1, 1, docV1], [ver2, 2, docV2]]) {
    const { error } = await admin.from("form_versions").insert({ id: vid, form_id: formA, workspace_id: wsA, published_version_no: no, schema_snapshot: doc, schema_version: 1, schema_hash: `hash-${no}`, renderer_version: "r", publisher_id: users.alice.id });
    if (error) throw new Error(`version ${no}: ${error.message}`);
  }
  const { error: pErr } = await admin.from("form_publications").insert({ id: pub, workspace_id: wsA, form_id: formA, form_version_id: ver2, public_id: `inbox-live-${tag}`.slice(0, 22), created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
  const times = ["2026-10-20T10:00:00Z", "2026-10-21T10:00:00Z", "2026-10-22T10:00:00Z", "2026-10-23T10:00:00Z"];
  const vers = [ver1, ver1, ver2, ver2];
  for (let i = 0; i < 4; i += 1) {
    const { error } = await admin.from("submissions").insert({ id: subIds[i], workspace_id: wsA, form_id: formA, publication_id: pub, form_version_id: vers[i], payload: payloads[i], idempotency_key: `live-inbox-${tag}-${i}`, submitted_at: times[i], status: "new" });
    if (error) throw new Error(`submission ${i}: ${error.message}`);
  }
}
await fixture();

const listUrl = (extra = "") => `${APP_URL}/app/${wsA}/forms/${formA}/submissions${extra}`;
const detailUrl = (id) => `${APP_URL}/app/${wsA}/forms/${formA}/submissions/${id}`;

/* ---------------- B1: authentication ---------------- */
check("B1", "session-less browser is redirected to login (list + detail)", async () => {
  for (const url of [listUrl(), detailUrl(subIds[0])]) {
    const res = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) throw new Error(`${url}: status ${res.status}`);
    const loc = res.headers.get("location") ?? "";
    if (!loc.includes("/login")) throw new Error(`${url}: redirect to ${loc}`);
  }
});
check("B1", "anonymous PostgREST reads return zero rows; anon cannot invoke status RPC", async () => {
  // No SELECT grant exists for anon, so PostgREST denies the query itself —
  // stronger than RLS-filtered emptiness: zero data, zero oracle.
  const { data, error } = await anonC.from("submissions").select("id");
  if (!error || !/permission denied/i.test(error.message)) {
    throw new Error(`anon select unexpected: ${error?.message ?? `${(data ?? []).length} rows`}`);
  }
  if ((data ?? []).length !== 0) throw new Error("anon reads submissions");
  const rpc = await anonC.rpc("set_submission_status", { p_submission_id: subIds[0], p_status: "read" });
  if (!rpc.error) throw new Error("anon invoked status RPC");
});

/* ---------------- B2: tenant isolation ---------------- */
check("B2", "workspace B member sees nothing of workspace A", async () => {
  const seen = await clients.mallory.from("submissions").select("id").eq("workspace_id", wsA);
  if ((seen.data ?? []).length !== 0) throw new Error("cross-workspace read allowed");
  const one = await clients.mallory.from("submissions").select("id").eq("id", subIds[0]);
  if ((one.data ?? []).length !== 0) throw new Error("known-ID cross-workspace read allowed");
  const rpc = await clients.mallory.rpc("set_submission_status", { p_submission_id: subIds[0], p_status: "read" });
  if (!rpc.error || !/forbidden|not found/.test(rpc.error.message)) throw new Error(`cross-workspace update: ${rpc.error?.message ?? "allowed"}`);
});
check("B2", "URL substitution (wsB path + wsA submission) is denied", async () => {
  const res = await fetch(`${APP_URL}/app/${wsB}/forms/${formA}/submissions/${subIds[0]}`, {
    headers: { cookie: cookies.alice },
    redirect: "manual",
  });
  if (res.status !== 404) throw new Error(`substituted URL status ${res.status}`);
});

/* ---------------- B3: roles ---------------- */
check("B3", "owner/builder list + detail; viewer/data_collaborator/stranger denied", async () => {
  for (const [name, c] of [["alice", clients.alice], ["bob", clients.bob]]) {
    const listed = await c.from("submissions").select("id").eq("workspace_id", wsA).eq("form_id", formA);
    if ((listed.data ?? []).length !== 4) throw new Error(`${name} lists ${(listed.data ?? []).length}, want 4`);
    const one = await c.from("submissions").select("id,payload").eq("id", subIds[0]);
    if ((one.data ?? []).length !== 1) throw new Error(`${name} cannot read detail`);
  }
  for (const [name, c] of [["cara", clients.cara], ["dave", clients.dave], ["mallory", clients.mallory]]) {
    const listed = await c.from("submissions").select("id").eq("workspace_id", wsA);
    if ((listed.data ?? []).length !== 0) throw new Error(`${name} lists submissions`);
  }
  // Action layer mirrors the matrix (viewer + stranger get 404, not 500).
  const denied = await asTempRoute(cookies.dave, { op: "list", workspaceId: wsA, formId: formA });
  if (denied.status !== 404) throw new Error(`viewer list status ${denied.status}`);
});
check("B3", "data_collaborator updates status without read access", async () => {
  const rpc = await clients.cara.rpc("set_submission_status", { p_submission_id: subIds[1], p_status: "archived" });
  if (rpc.error) throw new Error(`data_collaborator update: ${rpc.error.message}`);
  if (rpc.data?.status !== "archived" || rpc.data?.previous !== "new") throw new Error(`bad receipt ${JSON.stringify(rpc.data)}`);
  // …but still cannot read the row back.
  const back = await clients.cara.from("submissions").select("id").eq("id", subIds[1]);
  if ((back.data ?? []).length !== 0) throw new Error("data_collaborator reads after update");
  // Restore for later gates.
  const restore = await clients.alice.rpc("set_submission_status", { p_submission_id: subIds[1], p_status: "new" });
  if (restore.error) throw new Error(`restore: ${restore.error.message}`);
});
check("B3", "viewer/stranger status updates denied at RPC and action layers", async () => {
  for (const c of [clients.dave, clients.mallory]) {
    const rpc = await c.rpc("set_submission_status", { p_submission_id: subIds[1], p_status: "read" });
    if (!rpc.error || !/forbidden|not found/.test(rpc.error.message)) throw new Error(`denied update allowed: ${rpc.error?.message ?? "ok"}`);
  }
  const viaAction = await asTempRoute(cookies.dave, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: subIds[1], status: "read" });
  if (viaAction.status !== 404) throw new Error(`viewer action status ${viaAction.status}`);
});

/* ---------------- B4: historical rendering ---------------- */
check("B4", "v1 submission still renders through the v1 snapshot after v2 publish", async () => {
  const res = await asTempRoute(cookies.alice, { op: "get", workspaceId: wsA, formId: formA, submissionId: subIds[0] });
  if (res.status !== 200 || !res.body?.ok) throw new Error(`detail failed: ${res.status} ${JSON.stringify(res.body)}`);
  const labels = res.body.detail.snapshot.pages[0].sections[0].fields.map((f) => f.label);
  if (!labels.includes("Full name") || labels.includes("Your full name")) throw new Error(`wrong snapshot: ${labels.join("|")}`);
  if (res.body.detail.publishedVersionNo !== 1) throw new Error(`wrong version ${res.body.detail.publishedVersionNo}`);
  const res2 = await asTempRoute(cookies.alice, { op: "get", workspaceId: wsA, formId: formA, submissionId: subIds[2] });
  if (res2.body?.detail?.publishedVersionNo !== 2) throw new Error("v2 submission not pinned to v2");
  const labels2 = res2.body.detail.snapshot.pages[0].sections[0].fields.map((f) => f.label);
  if (!labels2.includes("Your full name") || !labels2.includes("Email")) throw new Error("v2 snapshot incomplete");
  // Rendered page shows the pinned labels (not the latest draft).
  const page = await fetch(detailUrl(subIds[0]), { headers: { cookie: cookies.alice } });
  const html = await page.text();
  if (page.status !== 200 || !html.includes("Full name") || !html.includes("Ann Alpha")) {
    throw new Error(`detail page missing pinned content (status ${page.status})`);
  }
});

/* ---------------- B5: payload privacy ---------------- */
check("B5", "audit rows and RPC receipts carry metadata only, never payloads", async () => {
  await asTempRoute(cookies.alice, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: subIds[3], status: "archived" });
  const rows = await admin.from("audit_log").select("action,diff").eq("workspace_id", wsA).eq("resource_type", "submission").order("created_at", { ascending: false }).limit(5);
  if ((rows.data ?? []).length === 0) throw new Error("no submission audit rows");
  const blob = JSON.stringify(rows.data);
  for (const secret of ["Ann Alpha", "Bo Beta", "Cy Gamma", "cy@example.test"]) {
    if (blob.includes(secret)) throw new Error("respondent payload leaked into audit");
  }
  if (!blob.includes("submission.status_changed")) throw new Error("status change not audited");
});

/* ---------------- B6: pagination ---------------- */
check("B6", "keyset pages are bounded and complete (no unrestricted dump)", async () => {
  const p1 = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 2 });
  if (p1.status !== 200 || !p1.body?.ok) throw new Error(`page 1 failed: ${p1.status}`);
  if (p1.body.page.rows.length !== 2 || p1.body.page.total !== 4 || !p1.body.page.nextCursor) {
    throw new Error(`bad page 1: ${JSON.stringify(p1.body.page).slice(0, 200)}`);
  }
  const p2 = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 2, cursor: p1.body.page.nextCursor });
  if (p2.body?.page?.rows?.length !== 2 || p2.body?.page?.nextCursor !== null) throw new Error("bad page 2");
  const ids = [...p1.body.page.rows, ...p2.body.page.rows].map((r) => r.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...subIds].sort())) throw new Error("pagination missed rows");
  // Limit is clamped server-side.
  const big = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, limit: 500 });
  if ((big.body?.page?.rows?.length ?? 0) > 100) throw new Error("page size not bounded");
});

/* ---------------- B7: mutations ---------------- */
check("B7", "archive/unarchive round-trips with audit; invalid input rejected", async () => {
  const arch = await asTempRoute(cookies.bob, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: subIds[0], status: "archived" });
  if (arch.status !== 200 || arch.body?.result?.status !== "archived") throw new Error(`archive failed: ${arch.status} ${JSON.stringify(arch.body)}`);
  const un = await asTempRoute(cookies.bob, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: subIds[0], status: "read" });
  if (un.body?.result?.previous !== "archived") throw new Error("unarchive receipt wrong");
  const bad = await asTempRoute(cookies.bob, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: subIds[0], status: "deleted" });
  if (bad.status === 200) throw new Error("invalid status accepted");
  const ghost = await asTempRoute(cookies.bob, { op: "setStatus", workspaceId: wsA, formId: formA, submissionId: randomUUID(), status: "read" });
  if (ghost.status !== 404) throw new Error(`unknown id status ${ghost.status}`);
});

/* ---------------- B8: search/filter ---------------- */
check("B8", "text search, status and date filters are server-backed", async () => {
  const t0 = performance.now();
  const hit = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { q: "Bo Beta" } });
  console.log(`   [S] filtered list query: ${(performance.now() - t0).toFixed(1)}ms`);
  if (hit.body?.page?.total !== 1 || hit.body?.page?.rows?.[0]?.summary?.primary !== "Bo Beta") {
    throw new Error(`search missed: ${JSON.stringify(hit.body?.page)}`);
  }
  const miss = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { q: "zzz-no-match" } });
  if (miss.body?.page?.total !== 0) throw new Error("search false positive");
  const archived = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { status: "archived" } });
  if ((archived.body?.page?.total ?? -1) < 1) throw new Error("status filter missed archived rows");
  const dated = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { from: "2026-10-22T00:00:00Z", to: "2026-10-23T00:00:00Z" } });
  if (dated.body?.page?.total !== 1) throw new Error(`date filter total ${dated.body?.page?.total}`);
  const byId = await asTempRoute(cookies.alice, { op: "list", workspaceId: wsA, formId: formA, filters: { q: subIds[0] } });
  if (byId.body?.page?.total !== 1) throw new Error("UUID search missed");
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
console.log(failed === 0 ? "SUBMISSION INBOX LIVE VERIFICATION: ALL GATES PASS" : `SUBMISSION INBOX LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
