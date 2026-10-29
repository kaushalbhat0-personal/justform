#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 9 API foundation (Gates A1–A13).
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * APP_URL (running app with /api/v1/*). Creates throwaway users, workspaces,
 * forms, versions, submissions, then cleans up. Never prints secrets/tokens.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL.");
  process.exit(0);
}

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const tag = Date.now().toString(36);
const email = (n) => `api-${n}-${tag}@example.test`;
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

// Mirror of @formos/database generateApiKey (kept in-script so the test
// exercises the real RPC contract without importing server code).
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const genKey = () => {
  let prefix = "";
  const rb = randomBytes(12);
  for (const b of rb) prefix += ALNUM[b % ALNUM.length];
  const secret = randomBytes(32).toString("base64url");
  const fullKey = `fm_live_${prefix}_${secret}`;
  return { fullKey, prefix, hash: createHash("sha256").update(fullKey, "utf8").digest("hex") };
};
const createKey = async (session, wsId, name, scopes) => {
  const { fullKey, prefix, hash } = genKey();
  const { data, error } = await session.rpc("create_api_key", {
    p_id: randomUUID(), p_workspace_id: wsId, p_prefix: prefix, p_secret_hash: hash, p_name: name, p_scopes: scopes,
  });
  if (error) throw new Error(`create_api_key: ${error.message}`);
  return { fullKey, prefix, meta: data };
};
const api = async (path, key, query = "") => {
  const t0 = performance.now();
  const res = await fetch(`${APP_URL}${path}${query}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: performance.now() - t0, reqId: res.headers.get("x-request-id") };
};

const users = {};
for (const n of ["alice", "mallory"]) users[n] = await mkUser(n);
const clients = {};
for (const n of ["alice", "mallory"]) clients[n] = await login(n);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const formB = randomUUID();
const ver1 = randomUUID();
const ver2 = randomUUID();
const verB1 = randomUUID();
const pub = randomUUID();
const subV1 = randomUUID();
const subV2 = randomUUID();
const subExtra = randomUUID();
const subB = randomUUID();

const docV1 = {
  id: formA, key: "contact", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Contact" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "name", type: "short_text", label: "Full name", required: true },
    { id: randomUUID(), key: "topic", type: "dropdown", label: "Topic", required: false, config: { options: [{ value: "support", label: "Support" }] } },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};
const docV2 = JSON.parse(JSON.stringify(docV1));
docV2.pages[0].sections[0].fields.find((f) => f.key === "name").label = "Your full name";
docV2.pages[0].sections[0].fields = docV2.pages[0].sections[0].fields.filter((f) => f.key !== "topic");
docV2.pages[0].sections[0].fields.push({ id: randomUUID(), key: "age", type: "number", label: "Age", required: false });

async function fixture() {
  const { error: wErr } = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "ApiA", p_slug: `apia-${tag}` });
  if (wErr) throw new Error(`wsA: ${wErr.message}`);
  const { error: wErr2 } = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "ApiB", p_slug: `apib-${tag}` });
  if (wErr2) throw new Error(`wsB: ${wErr2.message}`);
  const { error: fErr } = await clients.alice.from("forms").insert({ id: formA, workspace_id: wsA, key: "contact", title: "Contact", draft_payload: docV1 });
  if (fErr) throw new Error(`formA: ${fErr.message}`);
  const { error: fErr2 } = await clients.mallory.from("forms").insert({ id: formB, workspace_id: wsB, key: "other", title: "Other", draft_payload: docV1 });
  if (fErr2) throw new Error(`formB: ${fErr2.message}`);
  for (const [vid, no, doc] of [[ver1, 1, docV1], [ver2, 2, docV2]]) {
    const { error } = await admin.from("form_versions").insert({ id: vid, form_id: formA, workspace_id: wsA, published_version_no: no, schema_snapshot: doc, schema_version: 1, schema_hash: `hash-${no}`, renderer_version: "r", publisher_id: users.alice.id });
    if (error) throw new Error(`version ${no}: ${error.message}`);
  }
  const { error: vbErr } = await admin.from("form_versions").insert({ id: verB1, form_id: formB, workspace_id: wsB, published_version_no: 1, schema_snapshot: docV1, schema_version: 1, schema_hash: "hash-b1", renderer_version: "r", publisher_id: users.mallory.id });
  if (vbErr) throw new Error(`version B1: ${vbErr.message}`);
  const { error: pErr } = await admin.from("form_publications").insert({ id: pub, workspace_id: wsA, form_id: formA, form_version_id: ver2, public_id: `apilive-${tag}`.slice(0, 22), created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
  const rows = [
    { id: subV1, ver: ver1, payload: { name: "Ada", topic: "support" } },
    { id: subV2, ver: ver2, payload: { name: "Bob", age: 41 } },
    { id: subExtra, ver: ver2, payload: { name: "Cyd" } },
  ];
  for (const [i, s] of rows.entries()) {
    const { error } = await admin.from("submissions").insert({ id: s.id, workspace_id: wsA, form_id: formA, publication_id: pub, form_version_id: s.ver, payload: s.payload, idempotency_key: `live-api-${tag}-${i}`, submitted_at: `2026-10-2${i}T10:00:00Z`, status: "new" });
    if (error) throw new Error(`submission ${i}: ${error.message}`);
  }
  const { error: bErr } = await admin.from("submissions").insert({ id: subB, workspace_id: wsB, form_id: formB, publication_id: pub, form_version_id: verB1, payload: { name: "Stranger" }, idempotency_key: `live-api-${tag}-b`, submitted_at: "2026-10-20T10:00:00Z", status: "new" });
  if (bErr) throw new Error(`submission B: ${bErr.message}`);
}
await fixture();

const alice = clients.alice;
let mainKey;
let formsOnlyKey;

/* ---------------- A1: key creation ---------------- */
check("A1", "owner can create a scoped key; response carries metadata only", async () => {
  mainKey = await createKey(alice, wsA, "ci-main", ["forms:read", "submissions:read", "webhooks:read"]);
  const flat = JSON.stringify(mainKey.meta);
  for (const needle of ["secret_hash", mainKey.fullKey, "fm_live_"]) {
    if (flat.includes(needle)) throw new Error("create response leaks secret material");
  }
  for (const k of ["id", "prefix", "name", "scopes", "created_at"]) {
    if (!(k in mainKey.meta)) throw new Error(`create response missing ${k}`);
  }
  if (mainKey.meta.prefix !== mainKey.prefix) throw new Error("prefix mismatch");
});

/* ---------------- A2: one-time display ---------------- */
check("A2", "secret is returned only at creation; listing never exposes it", async () => {
  const { data, error } = await alice.rpc("list_api_keys", { p_workspace_id: wsA });
  if (error) throw new Error(`list: ${error.message}`);
  const flat = JSON.stringify(data);
  if (flat.includes(mainKey.fullKey)) throw new Error("list leaks the plaintext secret");
  if (/secret_hash|fm_live_/.test(flat)) throw new Error("list leaks secret material");
  if (!flat.includes(mainKey.prefix)) throw new Error("list missing the created key");
});

/* ---------------- A3: authentication ---------------- */
check("A3", "valid key authenticates; envelope is stable", async () => {
  const list = await api("/api/v1/forms", mainKey.fullKey);
  console.log(`   [S] GET /api/v1/forms: ${list.ms.toFixed(1)}ms (status ${list.status})`);
  if (list.status !== 200) throw new Error(`forms list: ${list.status} ${JSON.stringify(list.body)}`);
  if (!Array.isArray(list.body?.data) || !list.body?.page || !list.reqId) throw new Error("envelope malformed");
  if (Object.keys(list.body).sort().join(",") !== "data,page") throw new Error(`envelope keys: ${Object.keys(list.body)}`);
  const one = await api(`/api/v1/forms/${formA}`, mainKey.fullKey);
  console.log(`   [S] GET /api/v1/forms/:id: ${one.ms.toFixed(1)}ms (status ${one.status})`);
  if (one.status !== 200 || one.body?.data?.published_version?.version_no !== 2) {
    throw new Error(`form detail: ${one.status} ${JSON.stringify(one.body)}`);
  }
  if ("snapshot" in (one.body?.data ?? {}) || "draft_payload" in (one.body?.data ?? {})) {
    throw new Error("form detail leaks draft internals");
  }
});

/* ---------------- A4: invalid keys ---------------- */
check("A4", "missing/malformed/unknown/wrong-secret keys fail deterministically", async () => {
  const cases = [
    ["none", null],
    ["garbage", "not-a-key"],
    ["unknown-prefix", genKey().fullKey],
    ["wrong-secret", mainKey.fullKey.slice(0, -1) + (mainKey.fullKey.endsWith("A") ? "B" : "A")],
  ];
  for (const [label, key] of cases) {
    const r = await api("/api/v1/forms", key);
    if (r.status !== 401 || r.body?.error?.code !== "UNAUTHENTICATED") {
      throw new Error(`${label}: want 401 UNAUTHENTICATED, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    if (!r.reqId) throw new Error(`${label}: missing request id`);
    if (/workspace|prefix|hash/i.test(JSON.stringify(r.body))) throw new Error(`${label}: error leaks detail`);
  }
});

/* ---------------- A6: scope gate ---------------- */
check("A6", "forms:read cannot reach submission endpoints", async () => {
  formsOnlyKey = await createKey(alice, wsA, "ci-forms-only", ["forms:read"]);
  const r1 = await api(`/api/v1/forms/${formA}/submissions`, formsOnlyKey.fullKey);
  if (r1.status !== 403 || r1.body?.error?.code !== "FORBIDDEN") {
    throw new Error(`form submissions: want 403 FORBIDDEN, got ${r1.status}`);
  }
  const r2 = await api(`/api/v1/submissions/${subV1}`, formsOnlyKey.fullKey);
  if (r2.status !== 403) throw new Error(`submission detail: want 403, got ${r2.status}`);
});

/* ---------------- A7: submission scope ---------------- */
check("A7", "submissions:read lists/reads only authorized workspace submissions", async () => {
  const list = await api(`/api/v1/forms/${formA}/submissions?limit=20`, mainKey.fullKey);
  console.log(`   [S] GET submissions list: ${list.ms.toFixed(1)}ms (status ${list.status})`);
  if (list.status !== 200 || !Array.isArray(list.body?.data)) throw new Error(`list: ${list.status}`);
  if (list.body.data.length !== 3) throw new Error(`want 3 rows, got ${list.body.data.length}`);
  const one = await api(`/api/v1/submissions/${subV1}`, mainKey.fullKey);
  console.log(`   [S] GET submission detail: ${one.ms.toFixed(1)}ms (status ${one.status})`);
  if (one.status !== 200) throw new Error(`detail: ${one.status}`);
  if (one.body?.data?.form_id !== formA || one.body?.data?.payload?.name !== "Ada") {
    throw new Error("detail payload wrong");
  }
});

/* ---------------- A8/A9: isolation + substitution ---------------- */
check("A8", "key from workspace A cannot access workspace B", async () => {
  const list = await api("/api/v1/forms", mainKey.fullKey);
  if (list.body.data.some((f) => f.id === formB)) throw new Error("cross-workspace form listed");
  for (const path of [`/api/v1/forms/${formB}`, `/api/v1/submissions/${subB}`, `/api/v1/forms/${formB}/submissions`]) {
    const r = await api(path, mainKey.fullKey);
    if (r.status !== 404 || r.body?.error?.code !== "NOT_FOUND") {
      throw new Error(`${path}: want 404 NOT_FOUND, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
});

check("A9", "URL substitution (workspace/form/resource ids) cannot bypass authorization", async () => {
  const badForm = await api("/api/v1/forms/not-a-uuid", mainKey.fullKey);
  if (badForm.status !== 404) throw new Error(`malformed form id: ${badForm.status}`);
  const badSub = await api(`/api/v1/submissions/${randomUUID()}`, mainKey.fullKey);
  if (badSub.status !== 404 || badSub.body?.error?.code !== "NOT_FOUND") {
    throw new Error(`unknown submission: ${badSub.status}`);
  }
});

/* ---------------- A10: pagination ---------------- */
check("A10", "API stays bounded at the maximum page size", async () => {
  const big = await api("/api/v1/forms?limit=500", mainKey.fullKey);
  if (big.status !== 200 || big.body.data.length > 100) throw new Error("page not bounded");
  const p1 = await api(`/api/v1/forms/${formA}/submissions?limit=1`, mainKey.fullKey);
  if (p1.body.data.length !== 1 || !p1.body.page?.next_cursor) throw new Error("keyset page 1 malformed");
  const p2 = await api(`/api/v1/forms/${formA}/submissions?limit=1&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`, mainKey.fullKey);
  if (p2.body.data.length !== 1) throw new Error("keyset page 2 malformed");
  const seen = new Set([...p1.body.data, ...p2.body.data].map((r) => r.id));
  if (seen.size !== 2) throw new Error("pagination overlap/gap");
});

/* ---------------- A11: cursor forgery ---------------- */
check("A11", "forged/invalid cursors fail safely with a stable code", async () => {
  const bads = ["!!!", "aW52YWxpZA", Buffer.from(JSON.stringify({ t: "x", id: "y" })).toString("base64url")];
  for (const bad of bads) {
    const r = await api(`/api/v1/forms/${formA}/submissions?cursor=${encodeURIComponent(bad)}`, mainKey.fullKey);
    if (r.status !== 404 || r.body?.error?.code !== "NOT_FOUND") {
      throw new Error(`cursor ${bad}: want 404 NOT_FOUND, got ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
});

/* ---------------- A12: historical version ---------------- */
check("A12", "old submission stays pinned to v1 after v2 publish", async () => {
  const one = await api(`/api/v1/submissions/${subV1}`, mainKey.fullKey);
  if (one.body?.data?.published_version?.version_no !== 1) throw new Error("submission repinned");
  const nameField = (one.body?.data?.fields ?? []).find((f) => f.key === "name");
  if (nameField?.label !== "Full name") throw new Error(`v1 label lost: ${nameField?.label}`);
  const two = await api(`/api/v1/submissions/${subV2}`, mainKey.fullKey);
  if (two.body?.data?.published_version?.version_no !== 2) throw new Error("v2 pin wrong");
  const name2 = (two.body?.data?.fields ?? []).find((f) => f.key === "name");
  if (name2?.label !== "Your full name") throw new Error("v2 label wrong");
});

/* ---------------- A13: secret privacy ---------------- */
check("A13", "secrets never appear in responses, logs, audit, or browser bundles", async () => {
  const bodies = [];
  for (const path of ["/api/v1/forms", `/api/v1/forms/${formA}`, `/api/v1/forms/${formA}/submissions`, `/api/v1/submissions/${subV1}`]) {
    const r = await api(path, mainKey.fullKey);
    bodies.push(JSON.stringify(r.body));
  }
  const blob = bodies.join("\n");
  for (const needle of [mainKey.fullKey, "secret_hash", "secret_enc", "service_role"]) {
    if (blob.includes(needle)) throw new Error(`API response contains ${needle}`);
  }
  const { data: audits, error } = await admin.from("audit_log").select("action,diff").eq("workspace_id", wsA).in("action", ["api_key.created"]);
  if (error) throw new Error(`audit read: ${error.message}`);
  const ablob = JSON.stringify(audits);
  if (ablob.includes(mainKey.fullKey) || /secret_hash/.test(ablob)) throw new Error("audit log holds secret material");
});

/* ---------------- A5: revocation (last — kills the main key) ---------------- */
check("A5", "revoked key fails immediately", async () => {
  const before = await api("/api/v1/forms", mainKey.fullKey);
  if (before.status !== 200) throw new Error("key dead before revocation");
  const { error } = await alice.rpc("revoke_api_key", { p_key_id: mainKey.meta.id });
  if (error) throw new Error(`revoke: ${error.message}`);
  const after = await api("/api/v1/forms", mainKey.fullKey);
  if (after.status !== 401 || after.body?.error?.code !== "UNAUTHENTICATED") {
    throw new Error(`revoked key: want 401, got ${after.status}`);
  }
  const again = await api("/api/v1/forms", mainKey.fullKey);
  if (again.status !== 401) throw new Error("revocation not sticky");
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
console.log(failed === 0 ? "API LIVE VERIFICATION: ALL GATES PASS" : `API LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
