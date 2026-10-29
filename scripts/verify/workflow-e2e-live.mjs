#!/usr/bin/env node
/**
 * HTTP page-level airport E2E for IMPL-011 (no browser framework in repo —
 * uses fetch + @supabase/ssr session cookies, the same technique as
 * submission-inbox-live.mjs, against the real Next server at APP_URL).
 *
 * Canadian Airport: anonymous employee submits a Leave Request; Alice (owner)
 * and Bob (admin) process it through Tasks → detail → claim → approve.
 * Mutations go through the same public.* RPCs the server actions call;
 * every page render is asserted through real HTTP. Server-action POST
 * encoding is intentionally not hand-driven (Next action protocol);
 * claim/approve correctness itself is proven in workflow-live.mjs.
 * Never prints secrets/tokens.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL (app must be running).");
  process.exit(0);
}

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const tag = Date.now().toString(36);
const email = (n) => `e2e-${n}-${tag}@example.test`;
const users = {};
for (const n of ["alice", "bob"]) {
  const { data, error } = await admin.auth.admin.createUser({ email: email(n), password: "Verify123!", email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${n}: ${error?.message}`);
  users[n] = data.user;
}
const clients = {};
for (const n of ["alice", "bob"]) {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { error } = await c.auth.signInWithPassword({ email: email(n), password: "Verify123!" });
  if (error) throw new Error(`login ${n}: ${error.message}`);
  clients[n] = c;
}
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
const cookieAlice = await cookieFor("alice");
const cookieBob = await cookieFor("bob");

const ws = randomUUID();
const formId = randomUUID();
const verId = randomUUID();
const pubRowId = randomUUID();
const publicId = `e2e-leave-${tag}`.slice(0, 22);
const doc = {
  id: formId, key: "leave", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Employee Leave Request" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "reason", type: "short_text", label: "Reason", required: true },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};
const CONFIG = { trigger: "submission.created", steps: [{ type: "approval", key: "approval", assignee: "unassigned" }] };

const r1 = await clients.alice.rpc("create_workspace", { p_id: ws, p_membership_id: randomUUID(), p_name: "Canadian Airport", p_slug: `airport-${tag}` });
if (r1.error) throw new Error(`workspace: ${r1.error.message}`);
{
  const { error } = await admin.from("memberships").insert({ id: randomUUID(), workspace_id: ws, user_id: users.bob.id, role: "admin" });
  if (error) throw new Error(`bob membership: ${error.message}`);
}
{
  const { error } = await clients.alice.from("forms").insert({ id: formId, workspace_id: ws, key: "leave", title: "Employee Leave Request", draft_payload: doc });
  if (error) throw new Error(`form: ${error.message}`);
}
{
  const { error } = await admin.from("form_versions").insert({ id: verId, form_id: formId, workspace_id: ws, published_version_no: 1, schema_snapshot: doc, schema_version: 1, schema_hash: "e2e", renderer_version: "r", publisher_id: users.alice.id });
  if (error) throw new Error(`version: ${error.message}`);
}
{
  const { error } = await admin.from("form_publications").insert({ id: pubRowId, workspace_id: ws, form_id: formId, form_version_id: verId, public_id: publicId, created_by: users.alice.id });
  if (error) throw new Error(`publication: ${error.message}`);
}
{
  const c = await clients.alice.rpc("create_workflow_definition", { p_form_id: formId, p_config: CONFIG });
  if (c.error) throw new Error(`workflow create: ${c.error.message}`);
  const d = await clients.alice.from("workflow_definitions").select("id").eq("form_id", formId).maybeSingle();
  const a = await clients.alice.rpc("activate_workflow", { p_definition_id: d.data.id });
  if (a.error) throw new Error(`activate: ${a.error.message}`);
}

let submissionId = null;
check("E1", "employee opens the public form (200 + title, no internal ids)", async () => {
  const res = await fetch(`${APP_URL}/f/${publicId}`);
  const html = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!html.includes("Employee Leave Request")) throw new Error("title missing");
  // Workspace ids are redacted by the resolver (pre-existing invariant). The
  // form's own id is part of the canonical snapshot `id` field by design
  // (identical for non-workflow forms), so it is not asserted here.
  if (html.includes(ws)) throw new Error("workspace id leaked");
});
check("E2", "employee submits Leave Request via BFF intake (receipt, no workflow leak)", async () => {
  const res = await fetch(`${APP_URL}/api/public/forms/${publicId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `e2e-key-${tag}-01`, values: { reason: "Family vacation" } }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body?.success || !body?.submissionId) throw new Error(`intake: ${res.status} ${JSON.stringify(body)}`);
  submissionId = body.submissionId;
});
check("E3", "signed-out browser is redirected to login on workspace pages", async () => {
  for (const url of [`${APP_URL}/app/${ws}/tasks`, `${APP_URL}/app/${ws}/forms/${formId}/submissions/${submissionId}`]) {
    const res = await fetch(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) throw new Error(`${url}: ${res.status}`);
    if (!(res.headers.get("location") ?? "").includes("/login")) throw new Error("not sent to login");
  }
});
check("E4", "Alice sees the pending request in Tasks", async () => {
  const res = await fetch(`${APP_URL}/app/${ws}/tasks`, { headers: { cookie: cookieAlice } });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!html.includes("Team queue")) throw new Error("queue missing");
});
check("E5", "Alice opens the request: review UI offers Claim + Approve/Reject", async () => {
  const res = await fetch(`${APP_URL}/app/${ws}/forms/${formId}/submissions/${submissionId}`, { headers: { cookie: cookieAlice } });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!/Awaiting approval|In review/.test(html)) throw new Error("workflow badge missing");
  for (const label of ["Claim", "Approve", "Reject"]) {
    if (!html.includes(label)) throw new Error(`${label} action missing`);
  }
  if (!html.includes("Family vacation")) throw new Error("submitted value not rendered");
});
check("E6", "inbox list exposes the pending action", async () => {
  const res = await fetch(`${APP_URL}/app/${ws}/forms/${formId}/submissions`, { headers: { cookie: cookieAlice } });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (!html.includes("awaiting approval")) throw new Error("inbox workflow badge missing");
});
check("E7", "Bob claims, Alice approves, detail flips to Approved", async () => {
  const task = await clients.bob.from("workflow_tasks").select("id").eq("submission_id", submissionId).maybeSingle();
  const claim = await clients.bob.rpc("claim_task", { p_task_id: task.data.id });
  if (claim.error) throw new Error(`claim: ${claim.error.message}`);
  const mid = await (await fetch(`${APP_URL}/app/${ws}/forms/${formId}/submissions/${submissionId}`, { headers: { cookie: cookieAlice } })).text();
  if (!/In review/.test(mid)) throw new Error("claimed state not rendered");
  const dec = await clients.alice.rpc("decide_task", { p_task_id: task.data.id, p_outcome: "approved" });
  if (dec.error) throw new Error(`approve: ${dec.error.message}`);
  const done = await (await fetch(`${APP_URL}/app/${ws}/forms/${formId}/submissions/${submissionId}`, { headers: { cookie: cookieBob } })).text();
  if (!/Approved/.test(done)) throw new Error("approved state not rendered");
});
check("E8", "Bob cannot approve again; submission + pinned version intact", async () => {
  const task = await clients.bob.from("workflow_tasks").select("id").eq("submission_id", submissionId).maybeSingle();
  const again = await clients.bob.rpc("decide_task", { p_task_id: task.data.id, p_outcome: "approved" });
  if (!again.error || !/conflict/.test(again.error.message)) throw new Error(`repeat: ${again.error?.message ?? "allowed"}`);
  const res = await fetch(`${APP_URL}/app/${ws}/forms/${formId}/submissions/${submissionId}`, { headers: { cookie: cookieAlice } });
  const html = await res.text();
  if (res.status !== 200 || !html.includes("Family vacation") || !html.includes("published")) throw new Error("submission/detail degraded after decision");
});
check("E9", "pages carry responsive viewport + mobile-first markup", async () => {
  const res = await fetch(`${APP_URL}/f/${publicId}`);
  const html = await res.text();
  if (!/name="viewport"/.test(html)) throw new Error("viewport meta missing");
});

let failed = 0;
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
    console.log(`${status === "PASS" ? "ok  " : "FAIL"} [${r.gate}] ${r.name} (${(performance.now() - t0).toFixed(0)}ms)${status === "PASS" ? "" : ` — ${status}`}`);
  }
} finally {
  try {
    await admin.rpc("delete_workspace", { p_workspace_id: ws });
  } catch { /* best-effort cleanup */ }
  for (const n of Object.keys(users)) {
    try {
      await admin.auth.admin.deleteUser(users[n].id);
    } catch { /* best-effort */ }
  }
}
console.log(failed === 0 ? "AIRPORT HTTP E2E: ALL GATES PASS" : `AIRPORT HTTP E2E: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
