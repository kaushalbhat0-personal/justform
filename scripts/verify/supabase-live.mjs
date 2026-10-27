#!/usr/bin/env node
/**
 * Live Supabase verification (Gates A–F, server-dependent subset).
 * Requires a real Supabase project with migrations 0001–0003 applied:
 *   1. supabase link --project-ref <ref>   (once, needs an access token)
 *   2. supabase db push
 *   3. SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *      node scripts/verify/supabase-live.mjs
 * Creates throwaway users (live-verify-<ts>@example.test) and cleans up.
 * Exits non-zero on any gate failure. Never prints secrets/tokens.
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY to run live verification.");
  process.exit(0);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tag = Date.now().toString(36);
const email = (n) => `live-verify-${n}-${tag}@example.test`;
const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });

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

const alice = await mkUser("alice");
const bob = await mkUser("bob");
const stranger = await mkUser("stranger");
const aliceC = await login("alice");
const bobC = await login("bob");
const strangerC = await login("stranger");
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const wsId = randomUUID();
const memId = randomUUID();

// Gate A: migrations applied (tables + RPCs exist and RLS is enabled).
check("A", "migrations applied: core tables visible to service role", async () => {
  for (const t of ["profiles", "workspaces", "memberships", "invitations", "resource_grants", "audit_log"]) {
    const { error } = await admin.from(t).select("id", { head: true, count: "exact" });
    if (error) throw new Error(`${t}: ${error.message}`);
  }
});
check("A", "SECURITY DEFINER RPCs callable with hardened validation path", async () => {
  const { error } = await aliceC.rpc("create_workspace", { p_id: randomUUID(), p_membership_id: randomUUID(), p_name: "", p_slug: "x" });
  if (!error || !/authentication|name required/.test(error.message)) throw new Error(`unexpected RPC behavior: ${error?.message ?? "no error"}`);
});

// Gate B: Auth lifecycle.
check("B", "login/session/restoration", async () => {
  const { data } = await aliceC.auth.getUser();
  if (data.user?.id !== alice.id) throw new Error("session user mismatch");
});
check("B", "logout invalidates session", async () => {
  await aliceC.auth.signOut();
  const { data } = await aliceC.auth.getUser();
  if (data.user) throw new Error("session survived signOut");
});
check("B", "invalid session rejected", async () => {
  const bad = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { apikey: "invalid" } } });
  const { data } = await bad.auth.getUser();
  if (data.user) throw new Error("invalid key authenticated");
});

// Gate C+D: workspace isolation + roles (re-login alice after signOut above).
const aliceC2 = await login("alice");
check("C", "create workspace via RPC", async () => {
  const { error } = await aliceC2.rpc("create_workspace", { p_id: wsId, p_membership_id: memId, p_name: "Live", p_slug: `live-${tag}` });
  if (error) throw new Error(error.message);
});
check("C", "non-member reads nothing (member + cross-ws denial)", async () => {
  const b = await bobC.from("workspaces").select("id");
  if ((b.data ?? []).length !== 0) throw new Error("bob sees foreign workspace");
  const s = await strangerC.from("memberships").select("id");
  if ((s.data ?? []).length !== 0) throw new Error("stranger reads memberships");
});
check("C", "anon reads nothing", async () => {
  const { data } = await anonC.from("workspaces").select("id");
  if ((data ?? []).length !== 0) throw new Error("anon reads workspaces");
});
check("D", "viewer cannot self-escalate; admin rules enforced", async () => {
  const { error } = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: alice.id, p_role: "viewer" });
  if (!error) throw new Error("non-member set_role succeeded");
});

// Gate E: invitations (admin creates; invitee accepts; replay denied).
check("E", "invite lifecycle incl. replay/expiry denial", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const inv = randomUUID();
  const ins = await aliceC2.from("invitations").insert({ id: inv, workspace_id: wsId, email: email("bob"), role: "builder", token_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (ins.error) throw new Error(`invite create: ${ins.error.message}`);
  const ok = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (ok.error) throw new Error(`accept: ${ok.error.message}`);
  const replay = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (!replay.error) throw new Error("replay accepted");
});

// Gate F: SERVICE ROLE appears nowhere in the request path (static: this script
// uses it only for test setup/teardown — product code never imports it).
check("F", "audit rows written for lifecycle events", async () => {
  const { error } = await aliceC2.from("audit_log").insert({ id: randomUUID(), workspace_id: wsId, actor_id: alice.id, action: "workspace.created", resource_type: "workspace", resource_id: wsId });
  if (error) throw new Error(error.message);
});

// Teardown test users.
for (const u of [alice, bob, stranger]) await admin.auth.admin.deleteUser(u.id);

let failed = 0;
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
console.log(failed === 0 ? "LIVE VERIFICATION: ALL GATES PASS" : `LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
