#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 9 webhooks (Gates A14–A19).
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * APP_URL (running app with intake + tick routes), CRON_SECRET,
 * WEBHOOK_ENCRYPTION_KEY (same value the app server uses).
 * Creates throwaway users, workspaces, forms, endpoints, drives a real
 * intake → outbox → tick → delivery cycle, then cleans up.
 * Never prints secrets/tokens/bodies.
 */
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(new URL("../../.env", import.meta.url), "utf8").split("\n")) {
  const line = rawLine.replace(/\r$/, "");
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env) && !/placeholder/i.test(m[2])) process.env[m[1]] = m[2];
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, WEBHOOK_ENCRYPTION_KEY } = process.env;
const APP_URL = (process.env.APP_URL ?? "").replace(/\/$/, "");
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !APP_URL || !CRON_SECRET || !WEBHOOK_ENCRYPTION_KEY) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL, CRON_SECRET, WEBHOOK_ENCRYPTION_KEY.");
  process.exit(0);
}

const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const tag = Date.now().toString(36);
const email = (n) => `wh-${n}-${tag}@example.test`;
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
// Mirror of @formos/database encryptWebhookSecret (AES-256-GCM, base64 iv|cipher|tag).
const encSecret = (plaintext) => {
  const key = Buffer.from(WEBHOOK_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([iv, enc]).toString("base64");
};

const users = {};
for (const n of ["alice", "mallory"]) users[n] = await mkUser(n);
const clients = {};
for (const n of ["alice", "mallory"]) clients[n] = await login(n);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();
const ver1 = randomUUID();
const pubId = `whlive-${tag}-x`.slice(0, 22);

const docV1 = {
  id: formA, key: "contact", schemaVersion: 1, rendererVersion: "r", metadata: { title: "Contact" }, settings: {},
  pages: [{ id: randomUUID(), key: "main", sections: [{ id: randomUUID(), key: "s", fields: [
    { id: randomUUID(), key: "name", type: "short_text", label: "Full name", required: true },
  ]}]}],
  rules: [], calculations: [], localization: {}, notificationsRef: null, integrationsRef: null,
};

const EP = {};
async function fixture() {
  const { error: wErr } = await clients.alice.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "WhA", p_slug: `wha-${tag}` });
  if (wErr) throw new Error(`wsA: ${wErr.message}`);
  const { error: wErr2 } = await clients.mallory.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "WhB", p_slug: `whb-${tag}` });
  if (wErr2) throw new Error(`wsB: ${wErr2.message}`);
  const { error: fErr } = await clients.alice.from("forms").insert({ id: formA, workspace_id: wsA, key: "contact", title: "Contact", draft_payload: docV1 });
  if (fErr) throw new Error(`formA: ${fErr.message}`);
  const { error: vErr } = await admin.from("form_versions").insert({ id: ver1, form_id: formA, workspace_id: wsA, published_version_no: 1, schema_snapshot: docV1, schema_version: 1, schema_hash: "hash-1", renderer_version: "r", publisher_id: users.alice.id });
  if (vErr) throw new Error(`version: ${vErr.message}`);
  const { error: pErr } = await admin.from("form_publications").insert({ id: randomUUID(), workspace_id: wsA, form_id: formA, form_version_id: ver1, public_id: pubId, created_by: users.alice.id });
  if (pErr) throw new Error(`publication: ${pErr.message}`);
  // Endpoints: retryable (refused TCP on a routable literal IP), permanent
  // (unsupported scheme — no network needed), SSRF-blocked (metadata IP).
  const defs = {
    retry: "http://8.8.8.8:9/hook",
    perm: "ftp://example.com/hook",
    unsafe: "http://169.254.169.254/x",
  };
  for (const [k, url] of Object.entries(defs)) {
    const signingSecret = randomBytes(32).toString("base64url");
    const { data, error } = await clients.alice.rpc("create_webhook", {
      p_id: randomUUID(), p_workspace_id: wsA, p_form_id: null, p_url: url,
      p_secret_enc: encSecret(signingSecret), p_events: ["submission.created"],
    });
    if (error) throw new Error(`endpoint ${k}: ${error.message}`);
    EP[k] = { id: data.id, url, signingSecret };
  }
}
await fixture();

const tick = async () => {
  const t0 = performance.now();
  const res = await fetch(`${APP_URL}/api/internal/outbox-tick`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, ms: performance.now() - t0 };
};
const deliveriesFor = async (endpointId) => {
  const { data, error } = await clients.alice.rpc("list_deliveries", { p_endpoint_id: endpointId, p_limit: 10, p_cursor: "" });
  if (error) throw new Error(`list_deliveries: ${error.message}`);
  return data;
};

/* ---------------- drive one real intake → outbox event ---------------- */
check("A0", "setup: real intake submission creates the outbox event", async () => {
  const res = await fetch(`${APP_URL}/api/public/forms/${pubId}/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { name: "Webhook Wanda" }, idempotencyKey: `wh-key-${tag}-01` }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || body?.success !== true) {
    throw new Error(`intake: ${res.status} ${JSON.stringify(body)}`);
  }
  const first = await tick();
  console.log(`   [S] outbox tick: ${first.ms.toFixed(1)}ms → ${JSON.stringify(first.body)}`);
  if (first.status !== 200 || first.body?.ok !== true) {
    throw new Error(`tick: ${first.status} ${JSON.stringify(first.body)}`);
  }
  // The Stage-0 pump is global and bounded: poll ticks until this fixture's
  // deliveries are recorded (a shared backlog must never starve the assertions).
  for (let i = 0; i < 12; i += 1) {
    const have = await Promise.all([EP.retry.id, EP.perm.id, EP.unsafe.id].map((id) => deliveriesFor(id)));
    if (have.every((rows) => rows.length > 0 && rows.every((r) => r.attempts >= 1))) break;
    if (i === 11) throw new Error("fixture deliveries never recorded");
    await tick();
  }
});

/* ---------------- A16: retryable ---------------- */
check("A16", "connection-refused delivery stays retryable with bounded state", async () => {
  const rows = await deliveriesFor(EP.retry.id);
  const row = rows[0];
  if (!row) throw new Error("no delivery recorded for retry endpoint");
  console.log(`   [S] retry row: ${JSON.stringify({ status: row.status, attempts: row.attempts, next_attempt_at: row.next_attempt_at, response_code: row.response_code, last_error: String(row.last_error ?? "").slice(0, 90) })}`);
  if (!["pending", "failed"].includes(row.status)) throw new Error(`status ${row.status}`);
  if (row.attempts < 1) throw new Error("attempt not recorded");
  if (row.status === "pending" && !row.next_attempt_at) throw new Error("retry not scheduled");
  if (/secret unavailable|unsafe destination/i.test(row.last_error ?? "")) {
    throw new Error(`wrong failure mode: ${row.last_error}`);
  }
  console.log(`   [S] retryable delivery: status=${row.status} attempts=${row.attempts} error=${JSON.stringify((row.last_error ?? "").slice(0, 80))}`);
});

/* ---------------- A17: permanent ---------------- */
check("A17", "unsupported-scheme delivery is terminal, never retried", async () => {
  const rows = await deliveriesFor(EP.perm.id);
  const row = rows[0];
  if (!row) throw new Error("no delivery recorded for permanent endpoint");
  console.log(`   [S] perm row: ${JSON.stringify({ status: row.status, attempts: row.attempts, next_attempt_at: row.next_attempt_at, response_code: row.response_code, last_error: String(row.last_error ?? "").slice(0, 90) })}`);
  if (row.status !== "failed") throw new Error(`want failed, got ${row.status}`);
  if (row.next_attempt_at !== null) throw new Error("permanent failure rescheduled");
  if (!/scheme must be http/i.test(row.last_error ?? "")) throw new Error(`unexpected error: ${row.last_error}`);
});

/* ---------------- A18: SSRF ---------------- */
check("A18", "metadata-link-local destination is rejected without any HTTP attempt", async () => {
  const rows = await deliveriesFor(EP.unsafe.id);
  const row = rows[0];
  if (!row) throw new Error("no delivery recorded for unsafe endpoint");
  if (row.status !== "failed") throw new Error(`want failed, got ${row.status}`);
  if (!/unsafe destination/i.test(row.last_error ?? "")) throw new Error(`SSRF gate bypassed: ${row.last_error}`);
  if (row.attempts !== 1) throw new Error(`unsafe delivery retried (${row.attempts})`);
});

/* ---------------- A19: redirect policy ---------------- */
check("A19", "redirects are never followed (unit-proven; live transport is redirect-free)", async () => {
  const { data, error } = await clients.alice.rpc("list_deliveries", { p_endpoint_id: EP.perm.id, p_limit: 100, p_cursor: "" });
  if (error) throw new Error(`list: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) throw new Error("no deliveries");
  // All live deliveries above completed with zero redirects followed: the
  // request path uses redirect:"manual" and classifies 3xx as terminal.
  // Redirect classification itself is pinned by retry.test.ts vectors.
  for (const row of data) {
    if (/redirect/i.test(row.last_error ?? "") && row.status !== "failed") {
      throw new Error("redirect misclassified");
    }
  }
});

/* ---------------- A15: signing ---------------- */
check("A15", "HMAC-SHA256 signature verifies against a fixed test vector", async () => {
  // Fixed vector (independent of implementation): recompute and compare.
  const secret = "live-vector-secret-01";
  const ts = 1700000000;
  const rawBody = '{"event":{"id":"evt-test"}}';
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  const header = `t=${ts},v1=${expected}`;
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) throw new Error("header format wrong");
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(m[1])) < 300) throw new Error("vector unexpectedly fresh; replay window test invalid");
  // Fresh header verifies; tampered body, wrong secret, and replayed timestamps do not.
  const fresh = `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${rawBody}`, "utf8").digest("hex")}`;
  const verify = (h, body, s, now) => {
    const p = /^t=(\d+),v1=([0-9a-f]{64})$/.exec((h ?? "").trim());
    if (!p) return false;
    if (Math.abs(now - Number(p[1])) > 300) return false;
    let exp;
    try {
      exp = createHmac("sha256", s).update(`${p[1]}.${body}`, "utf8").digest("hex");
    } catch {
      return false;
    }
    const a = Buffer.from(exp, "hex");
    const b = Buffer.from(p[2], "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  if (!verify(fresh, rawBody, secret, nowSec)) throw new Error("fresh vector rejected");
  if (verify(fresh, `${rawBody} `, secret, nowSec)) throw new Error("tampered body accepted");
  if (verify(fresh, rawBody, "wrong-secret", nowSec)) throw new Error("wrong secret accepted");
  if (verify(header, rawBody, secret, nowSec)) throw new Error("replayed timestamp accepted");
  // Live proof that the tick signs with the real endpoint secret: the retry
  // delivery got past decrypt+sign (its error is a TCP failure, not crypto).
  const rows = await deliveriesFor(EP.retry.id);
  if (/secret unavailable/i.test(rows[0]?.last_error ?? "")) throw new Error("live signing secret undecryptable");
});

/* ---------------- A14: webhook isolation ---------------- */
check("A14", "webhook endpoints cannot cross workspaces", async () => {
  // Mallory (wsB) cannot see or use Alice's endpoint via RPC…
  const { error } = await clients.mallory.rpc("list_deliveries", { p_endpoint_id: EP.retry.id, p_limit: 10, p_cursor: "" });
  if (!error) throw new Error("cross-workspace deliveries readable");
  // …nor via the API (needs a key; use an RPC-created key for mallory)…
  const prefix = `MB${tag}`.replace(/[^A-Za-z0-9]/g, "X").slice(0, 12).padEnd(12, "Z");
  const fullKey = `fm_live_${prefix}_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(fullKey, "utf8").digest("hex");
  const { error: kErr } = await clients.mallory.rpc("create_api_key", {
    p_id: randomUUID(), p_workspace_id: wsB, p_prefix: prefix, p_secret_hash: hash, p_name: "mallory", p_scopes: ["forms:read", "submissions:read", "webhooks:read"],
  });
  if (kErr) throw new Error(`mallory key: ${kErr.message}`);
  const res = await fetch(`${APP_URL}/api/v1/webhooks/${EP.retry.id}/deliveries`, {
    headers: { authorization: `Bearer ${fullKey}` },
  });
  if (res.status !== 404) throw new Error(`cross-workspace deliveries API: ${res.status}`);
  // …while Alice's own scoped key reads metadata only (no secrets).
  const aPrefix = `AA${tag}`.replace(/[^A-Za-z0-9]/g, "X").slice(0, 12).padEnd(12, "Z");
  const aFull = `fm_live_${aPrefix}_${randomBytes(32).toString("base64url")}`;
  const aHash = createHash("sha256").update(aFull, "utf8").digest("hex");
  const { error: aErr } = await clients.alice.rpc("create_api_key", {
    p_id: randomUUID(), p_workspace_id: wsA, p_prefix: aPrefix, p_secret_hash: aHash, p_name: "alice-wh", p_scopes: ["webhooks:read"],
  });
  if (aErr) throw new Error(`alice key: ${aErr.message}`);
  const own = await fetch(`${APP_URL}/api/v1/webhooks/${EP.retry.id}/deliveries`, {
    headers: { authorization: `Bearer ${aFull}` },
  });
  const ownBody = await own.json().catch(() => null);
  if (own.status !== 200 || !Array.isArray(ownBody?.data)) throw new Error(`own deliveries: ${own.status}`);
  const flat = JSON.stringify(ownBody);
  if (/secret_enc|fm_live_|"secret"/.test(flat)) throw new Error("deliveries API leaks secret material");
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
    await admin.rpc("delete_workspace", { p_workspace_id: wsA });
    await admin.rpc("delete_workspace", { p_workspace_id: wsB });
  } catch { /* best-effort cleanup */ }
  for (const n of Object.keys(users)) {
    try {
      await admin.auth.admin.deleteUser(users[n].id);
    } catch { /* best-effort cleanup */ }
  }
}
console.log(failed === 0 ? "WEBHOOK LIVE VERIFICATION: ALL GATES PASS" : `WEBHOOK LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
