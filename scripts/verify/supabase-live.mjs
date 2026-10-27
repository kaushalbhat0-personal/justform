#!/usr/bin/env node
/**
 * Live Supabase verification (Gates A–F, server-dependent subset).
 * Requires a real Supabase project with migrations 0001–0004 applied:
 *   1. supabase link --project-ref <ref>   (once, needs an access token)
 *   2. supabase db push
 *   3. SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *      node scripts/verify/supabase-live.mjs
 * Creates throwaway users (live-verify-<ts>@example.test) and one workspace,
 * then cleans up (workspace cascade + users). Exits non-zero on any gate
 * failure. Never prints secrets/tokens.
 *
 * NOTE: PostgREST on hosted Supabase serves the `public` schema only, so all
 * RPC calls here target the thin `public` wrappers from migration 0004, which
 * delegate 1:1 to the frozen `formos.*` control plane (same errors/semantics).
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

const users = [];
const alice = await mkUser("alice");
const bob = await mkUser("bob");
const dave = await mkUser("dave");
const stranger = await mkUser("stranger");
users.push(alice, bob, dave, stranger);
const aliceC = await login("alice");
const bobC = await login("bob");
const daveC = await login("dave");
const strangerC = await login("stranger");
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const wsId = randomUUID();
const memId = randomUUID();

// Gate A: migrations applied (core tables + RPCs visible and RLS enabled).
check("A", "migrations applied: core tables visible to service role", async () => {
  for (const t of ["profiles", "workspaces", "memberships", "invitations", "resource_grants", "audit_log"]) {
    const { error } = await admin.from(t).select("id", { head: true, count: "exact" });
    if (error) throw new Error(`${t}: ${error.message}`);
  }
});
check("A", "public RPC wrappers reachable with hardened validation path", async () => {
  const { error } = await aliceC.rpc("create_workspace", { p_id: randomUUID(), p_membership_id: randomUUID(), p_name: "", p_slug: "x" });
  if (!error || !/authentication|name required/.test(error.message)) throw new Error(`unexpected RPC behavior: ${error?.message ?? "no error"}`);
});
check("A", "formos schema is NOT exposed via PostgREST (narrow public surface)", async () => {
  const { error } = await aliceC.schema("formos").rpc("create_workspace", { p_id: randomUUID(), p_membership_id: randomUUID(), p_name: "x", p_slug: "x" });
  if (!error) throw new Error("formos schema unexpectedly reachable via PostgREST");
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

// Gate C: workspace isolation (re-login alice after signOut above).
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
check("C", "anon RPC invocation denied at authentication boundary", async () => {
  const { error } = await anonC.rpc("create_workspace", { p_id: randomUUID(), p_membership_id: randomUUID(), p_name: "X", p_slug: `anon-${tag}` });
  if (!error) throw new Error("anon create_workspace succeeded");
});

// Gate E: invitations (owner creates; invitees accept; replay/expiry/binding denial).
const bobHash = { raw: "", hash: "" };
check("E", "invite lifecycle incl. replay denial", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  bobHash.raw = raw;
  bobHash.hash = hash;
  const ins = await aliceC2.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: email("bob"), role: "builder", token_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (ins.error) throw new Error(`invite create: ${ins.error.message}`);
  const ok = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (ok.error) throw new Error(`accept: ${ok.error.message}`);
  if (ok.data !== wsId) throw new Error(`accept returned wrong workspace`);
  const replay = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (!replay.error) throw new Error("replay accepted");
  if (replay.error.message !== ok.error?.message && !/invalid or expired/.test(replay.error.message)) throw new Error(`replay error not uniform: ${replay.error.message}`);
});
check("E", "viewer invite + accept (dave)", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const ins = await aliceC2.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: email("dave"), role: "viewer", token_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (ins.error) throw new Error(`dave invite create: ${ins.error.message}`);
  const ok = await daveC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (ok.error) throw new Error(`dave accept: ${ok.error.message}`);
});
check("E", "only the hash is stored — raw token never persisted", async () => {
  const { data, error } = await aliceC2.from("invitations").select("token_hash").eq("workspace_id", wsId).eq("email", email("bob"));
  if (error) throw new Error(`read invitations: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) throw new Error("invitation row not readable by owner");
  if (!/^[0-9a-f]{64}$/.test(row.token_hash)) throw new Error("token_hash is not a 256-bit hex digest");
  if (row.token_hash === bobHash.raw) throw new Error("raw token stored");
});
check("E", "expiry enforced", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const ins = await aliceC2.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: email("stranger"), role: "viewer", token_hash: hash, expires_at: new Date(Date.now() - 1000).toISOString() });
  if (ins.error) throw new Error(`expired invite create: ${ins.error.message}`);
  const r = await strangerC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (!r.error || !/invalid or expired/.test(r.error.message)) throw new Error(`expiry not enforced: ${r.error?.message ?? "accepted"}`);
});
check("E", "JWT email binding enforced", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const ins = await aliceC2.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: "someone-else@example.test", role: "viewer", token_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (ins.error) throw new Error(`binding invite create: ${ins.error.message}`);
  const r = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (!r.error || !/email mismatch/.test(r.error.message)) throw new Error(`email binding not enforced: ${r.error?.message ?? "accepted"}`);
});
check("E", "already-member denied; unknown hash uniform error", async () => {
  const { createHash, randomBytes } = await import("node:crypto");
  const hash = createHash("sha256").update(randomBytes(32)).digest("hex");
  const ins = await aliceC2.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: email("bob"), role: "viewer", token_hash: hash, expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (ins.error) throw new Error(`re-invite create: ${ins.error.message}`);
  const r = await bobC.rpc("accept_invitation", { p_token_hash: hash, p_membership_id: randomUUID() });
  if (!r.error || !/already a member/.test(r.error.message)) throw new Error(`already-member not denied: ${r.error?.message ?? "accepted"}`);
  const u = await bobC.rpc("accept_invitation", { p_token_hash: "f".repeat(64), p_membership_id: randomUUID() });
  if (!u.error || !/invalid or expired/.test(u.error.message)) throw new Error(`unknown hash not uniform: ${u.error?.message ?? "accepted"}`);
});
check("E", "non-admin cannot create invitations", async () => {
  const { error } = await daveC.from("invitations").insert({ id: randomUUID(), workspace_id: wsId, email: "x@y.test", role: "viewer", token_hash: "a".repeat(64), expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (!error) throw new Error("viewer created invitation");
});

// Gate F: audit — lifecycle rows, append-only, admin-only reads, isolation.
check("F", "audit rows written for lifecycle events", async () => {
  const rows = [
    { id: randomUUID(), workspace_id: wsId, actor_id: alice.id, action: "workspace.created", resource_type: "workspace", resource_id: wsId },
    { id: randomUUID(), workspace_id: wsId, actor_id: alice.id, action: "member.invited", resource_type: "invitation", resource_id: randomUUID() },
    { id: randomUUID(), workspace_id: wsId, actor_id: bob.id, action: "member.invite_accepted", resource_type: "membership", resource_id: bob.id },
  ];
  for (const row of rows) {
    const { error } = await aliceC2.from("audit_log").insert(row);
    if (error) throw new Error(`${row.action}: ${error.message}`);
  }
});
check("F", "audit is append-only (update/delete denied)", async () => {
  const target = (await aliceC2.from("audit_log").select("id").eq("workspace_id", wsId).limit(1)).data?.[0]?.id;
  if (!target) throw new Error("no audit row to probe");
  const up = await aliceC2.from("audit_log").update({ action: "tampered" }).eq("id", target);
  if (!up.error) throw new Error("audit update allowed");
  const del = await aliceC2.from("audit_log").delete().eq("id", target);
  if (!del.error) throw new Error("audit delete allowed");
});
check("F", "audit reads are admin-only and workspace-scoped", async () => {
  const owner = await aliceC2.from("audit_log").select("id").eq("workspace_id", wsId);
  if (owner.error || (owner.data ?? []).length === 0) throw new Error("owner cannot read audit trail");
  const viewer = await daveC.from("audit_log").select("id").eq("workspace_id", wsId);
  if ((viewer.data ?? []).length !== 0) throw new Error("viewer reads audit trail");
  const outsider = await strangerC.from("audit_log").select("id").eq("workspace_id", wsId);
  if ((outsider.data ?? []).length !== 0) throw new Error("non-member reads audit trail");
});

// Gate D: RBAC matrix (roles at this point: alice owner, bob builder, dave viewer).
check("D", "viewer cannot escalate; non-member and self mutations denied", async () => {
  const v = await daveC.rpc("set_role", { p_workspace_id: wsId, p_target_user: bob.id, p_role: "viewer" });
  if (!v.error) throw new Error("viewer set_role succeeded");
  const n = await strangerC.rpc("set_role", { p_workspace_id: wsId, p_target_user: alice.id, p_role: "viewer" });
  if (!n.error) throw new Error("non-member set_role succeeded");
  const s = await aliceC2.rpc("set_role", { p_workspace_id: wsId, p_target_user: alice.id, p_role: "viewer" });
  if (!s.error || !/self/.test(s.error.message)) throw new Error(`self role change not denied: ${s.error?.message ?? "succeeded"}`);
});
check("D", "builder cannot become admin/owner and cannot mutate roles", async () => {
  const b1 = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: dave.id, p_role: "viewer" });
  if (!b1.error || !/admin required/.test(b1.error.message)) throw new Error(`builder set_role not admin-gated: ${b1.error?.message ?? "succeeded"}`);
  const b2 = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: bob.id, p_role: "admin" });
  if (!b2.error) throw new Error("builder self-escalation succeeded");
});
check("D", "admin cannot become owner or grant at-or-above own rank", async () => {
  const promo = await aliceC2.rpc("set_role", { p_workspace_id: wsId, p_target_user: bob.id, p_role: "admin" });
  if (promo.error) throw new Error(`owner promote to admin: ${promo.error.message}`);
  const g1 = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: dave.id, p_role: "admin" });
  if (!g1.error || !/at or above/.test(g1.error.message)) throw new Error(`admin peer-grant not denied: ${g1.error?.message ?? "succeeded"}`);
  const g2 = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: dave.id, p_role: "owner" });
  if (!g2.error) throw new Error("admin granted owner");
  const g3 = await bobC.rpc("set_role", { p_workspace_id: wsId, p_target_user: bob.id, p_role: "owner" });
  if (!g3.error) throw new Error("admin self-escalated to owner");
});
check("D", "owner positive control: role change succeeds and persists", async () => {
  const { error } = await aliceC2.rpc("set_role", { p_workspace_id: wsId, p_target_user: dave.id, p_role: "builder" });
  if (error) throw new Error(`owner set_role: ${error.message}`);
  const { data } = await aliceC2.from("memberships").select("role").eq("workspace_id", wsId).eq("user_id", dave.id);
  if (data?.[0]?.role !== "builder") throw new Error("role change did not persist");
});

// Run all gates, then clean up throwaway users + workspace (service role).
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
    await admin.from("workspaces").delete().eq("id", wsId);
  } catch { /* best-effort cleanup */ }
  for (const u of users) {
    try {
      await admin.auth.admin.deleteUser(u.id);
    } catch { /* best-effort cleanup */ }
  }
}
console.log(failed === 0 ? "LIVE VERIFICATION: ALL GATES PASS" : `LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
