#!/usr/bin/env node
/**
 * Live Supabase verification for Phase 4 form persistence (Gates F1–F8).
 * Requires migrations 0001–0005 applied:
 *   supabase db push
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/verify/forms-live.mjs
 * Creates throwaway users + workspaces + forms, then cleans up (workspace
 * cascade + users). Exits non-zero on any gate failure. Never prints secrets.
 *
 * Scope: the DATABASE contract (tenancy, roles, OCC shape, publish numbering,
 * immutability, hash determinism). Canonical-shape validation lives in the
 * TypeScript server boundary (forms-engine + server actions); the harness
 * stores engine-shaped documents and verifies self-containment + hash.
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.log("SKIP: set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY to run live verification.");
  process.exit(0);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tag = Date.now().toString(36);
const email = (n) => `forms-verify-${n}-${tag}@example.test`;
const results = [];
const check = (gate, name, fn) => results.push({ gate, name, run: fn });

/** Deterministic canonical JSON (mirrors forms-engine stableStringify). */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const hashDoc = (doc) => createHash("sha256").update(stableStringify(doc), "utf8").digest("hex");

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
const carol = await mkUser("carol");
const stranger = await mkUser("stranger");
users.push(alice, bob, carol, stranger);
const aliceC = await login("alice");
const bobC = await login("bob");
const carolC = await login("carol");
const strangerC = await login("stranger");
const anonC = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const wsA = randomUUID();
const wsB = randomUUID();
const formA = randomUUID();

// Workspace setup via the frozen public RPC surface (IMPL-002 integration).
{
  const { error } = await aliceC.rpc("create_workspace", { p_id: wsA, p_membership_id: randomUUID(), p_name: "FormsLiveA", p_slug: `forms-live-a-${tag}` });
  if (error) throw new Error(`setup wsA: ${error.message}`);
  const { error: e2 } = await strangerC.rpc("create_workspace", { p_id: wsB, p_membership_id: randomUUID(), p_name: "FormsLiveB", p_slug: `forms-live-b-${tag}` });
  if (e2) throw new Error(`setup wsB: ${e2.message}`);
  // Seed memberships (harness setup only, mirrors PGlite asSuperuser seeding).
  for (const [id, ws, uid, role] of [[randomUUID(), wsA, bob.id, "builder"], [randomUUID(), wsA, carol.id, "viewer"]]) {
    const { error: e3 } = await admin.from("memberships").insert({ id, workspace_id: ws, user_id: uid, role });
    if (e3) throw new Error(`setup membership: ${e3.message}`);
  }
}

const docA = {
  id: formA,
  key: "intake",
  schemaVersion: 1,
  rendererVersion: "rjsf-6.11+drv1",
  metadata: { title: "Intake" },
  settings: {},
  pages: [
    {
      id: randomUUID(),
      key: "main",
      sections: [
        {
          id: randomUUID(),
          key: "s",
          fields: [{ id: randomUUID(), key: "name", type: "short_text", label: "Name", required: true }],
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

const timed = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  console.log(`   [S] ${label}: ${(performance.now() - t0).toFixed(1)}ms`);
  return out;
};

// F1: draft CRUD + OCC shape.
check("F1", "builder+ owner create drafts (revision starts at 1)", async () => {
  const { error } = await timed("draft insert", () =>
    aliceC.from("forms").insert({ id: formA, workspace_id: wsA, key: "intake", title: "Intake", schema_version: 1, draft_revision: 1, draft_payload: docA, created_by: alice.id, updated_by: alice.id }),
  );
  if (error) throw new Error(`insert: ${error.message}`);
});
check("F1", "OCC update with matching revision succeeds and increments", async () => {
  const { data, error } = await timed("draft update (OCC match)", () =>
    aliceC.from("forms").update({ title: "Intake v2", draft_revision: 2, updated_by: alice.id }).eq("id", formA).eq("draft_revision", 1).select("draft_revision"),
  );
  if (error) throw new Error(`update: ${error.message}`);
  if ((data ?? []).length !== 1 || data[0].draft_revision !== 2) throw new Error("revision did not increment atomically");
});
check("F1", "stale expected revision updates zero rows (conflict shape)", async () => {
  const { data, error } = await aliceC.from("forms").update({ title: "stale" }).eq("id", formA).eq("draft_revision", 1).select("id");
  if (error) throw new Error(`stale update errored instead of conflicting: ${error.message}`);
  if ((data ?? []).length !== 0) throw new Error("stale revision overwrote the draft");
});

// F2: roles on forms.
check("F2", "viewer reads but cannot write; builder manages", async () => {
  const seen = await carolC.from("forms").select("id");
  if ((seen.data ?? []).length !== 1) throw new Error("viewer cannot read workspace forms");
  const ins = await carolC.from("forms").insert({ id: randomUUID(), workspace_id: wsA, key: "nope", title: "Nope", draft_payload: {} });
  if (!ins.error) throw new Error("viewer insert allowed");
  const upd = await carolC.from("forms").update({ title: "X" }).eq("id", formA).select("id");
  if ((upd.data ?? []).length !== 0) throw new Error("viewer update allowed");
  const { error } = await bobC.from("forms").update({ title: "Intake v3", draft_revision: 3, updated_by: bob.id }).eq("id", formA).eq("draft_revision", 2).select("id");
  if (error) throw new Error(`builder update: ${error.message}`);
});
check("F2", "non-member and anonymous get nothing", async () => {
  const s = await strangerC.from("forms").select("id").eq("workspace_id", wsA);
  if ((s.data ?? []).length !== 0) throw new Error("stranger reads wsA forms");
  const ins = await strangerC.from("forms").insert({ id: randomUUID(), workspace_id: wsA, key: "z", title: "Z", draft_payload: {} });
  if (!ins.error) throw new Error("stranger insert allowed");
  const a = await anonC.from("forms").select("id");
  if ((a.data ?? []).length !== 0) throw new Error("anon reads forms");
});

// F3: cross-workspace denial with a known id.
check("F3", "cross-workspace read/update denied", async () => {
  const s = await strangerC.from("forms").select("id").eq("id", formA);
  if ((s.data ?? []).length !== 0) throw new Error("cross-workspace read allowed");
  const u = await strangerC.from("forms").update({ title: "X" }).eq("id", formA).select("id");
  if ((u.data ?? []).length !== 0) throw new Error("cross-workspace update allowed");
});

// F4: publish numbering + authorization.
check("F4", "sequential publishes mint versions 1, 2 (atomic numbering)", async () => {
  const v1 = await timed("publish v1", () => aliceC.rpc("publish_form", { p_version_id: randomUUID(), p_form_id: formA, p_snapshot: docA, p_schema_version: 1, p_schema_hash: hashDoc(docA), p_renderer_version: "rjsf-6.11+drv1", p_publisher: alice.id, p_expected_revision: 3 }));
  if (v1.error) throw new Error(`publish 1: ${v1.error.message}`);
  if (v1.data !== 1) throw new Error(`expected version 1, got ${v1.data}`);
  const v2 = await aliceC.rpc("publish_form", { p_version_id: randomUUID(), p_form_id: formA, p_snapshot: docA, p_schema_version: 1, p_schema_hash: hashDoc(docA), p_renderer_version: "rjsf-6.11+drv1", p_publisher: alice.id, p_expected_revision: 3 });
  if (v2.error) throw new Error(`publish 2: ${v2.error.message}`);
  if (v2.data !== 2) throw new Error(`expected version 2, got ${v2.data}`);
});
check("F4", "stale revision conflicts; viewer/stranger publish denied", async () => {
  const stale = await aliceC.rpc("publish_form", { p_version_id: randomUUID(), p_form_id: formA, p_snapshot: docA, p_schema_version: 1, p_schema_hash: hashDoc(docA), p_renderer_version: "r", p_publisher: alice.id, p_expected_revision: 1 });
  if (!stale.error || !/draft conflict/.test(stale.error.message)) throw new Error(`stale publish not a conflict: ${stale.error?.message ?? "succeeded"}`);
  const viewer = await carolC.rpc("publish_form", { p_version_id: randomUUID(), p_form_id: formA, p_snapshot: docA, p_schema_version: 1, p_schema_hash: "h", p_renderer_version: "r", p_publisher: carol.id, p_expected_revision: 3 });
  if (!viewer.error || !/builder required/.test(viewer.error.message)) throw new Error(`viewer publish not denied: ${viewer.error?.message ?? "succeeded"}`);
  const outsider = await strangerC.rpc("publish_form", { p_version_id: randomUUID(), p_form_id: formA, p_snapshot: docA, p_schema_version: 1, p_schema_hash: "h", p_renderer_version: "r", p_publisher: stranger.id, p_expected_revision: 3 });
  if (!outsider.error) throw new Error("non-member publish allowed");
});

// F5: published immutability (multi-layer).
check("F5", "versions immutable: no UPDATE/DELETE/INSERT via the client path", async () => {
  const up = await aliceC.from("form_versions").update({ schema_hash: "tampered" }).eq("form_id", formA);
  if (!up.error) throw new Error("version update allowed");
  const del = await aliceC.from("form_versions").delete().eq("form_id", formA);
  if (!del.error) throw new Error("version delete allowed");
  const ins = await aliceC.from("form_versions").insert({ id: randomUUID(), form_id: formA, workspace_id: wsA, published_version_no: 99, schema_snapshot: {}, schema_version: 1, schema_hash: "x", renderer_version: "r" });
  if (!ins.error) throw new Error("direct version insert allowed");
  const seen = await strangerC.from("form_versions").select("id").eq("form_id", formA);
  if ((seen.data ?? []).length !== 0) throw new Error("non-member reads version history");
});

// F6: hash determinism + self-containment.
check("F6", "same document → same hash; snapshot round-trips exactly", async () => {
  if (hashDoc(docA) !== hashDoc(JSON.parse(JSON.stringify(docA)))) throw new Error("hash unstable");
  const { data, error } = await timed("version read", () => aliceC.from("form_versions").select("schema_snapshot,schema_hash").eq("form_id", formA).eq("published_version_no", 1).maybeSingle());
  if (error || !data) throw new Error(`version read: ${error?.message ?? "missing"}`);
  if (stableStringify(data.schema_snapshot) !== stableStringify(docA)) throw new Error("snapshot is not self-contained");
  if (data.schema_hash !== hashDoc(docA)) throw new Error("stored hash mismatch");
});

// F7: slug scoping.
check("F7", "key uniqueness is per-workspace", async () => {
  const dup = await aliceC.from("forms").insert({ id: randomUUID(), workspace_id: wsA, key: "intake", title: "Dup", draft_payload: {} });
  if (!dup.error) throw new Error("duplicate key allowed in workspace");
  const other = await strangerC.from("forms").insert({ id: randomUUID(), workspace_id: wsB, key: "intake", title: "Other", draft_payload: {} });
  if (other.error) throw new Error(`same key in another workspace denied: ${other.error.message}`);
});

// F8: audit lifecycle events.
check("F8", "form.created / form.published audit rows member-writable, outsider-denied", async () => {
  for (const action of ["form.created", "form.published"]) {
    const { error } = await aliceC.from("audit_log").insert({ id: randomUUID(), workspace_id: wsA, actor_id: alice.id, action, resource_type: action === "form.created" ? "form" : "form_version", resource_id: formA });
    if (error) throw new Error(`${action}: ${error.message}`);
  }
  const denied = await strangerC.from("audit_log").insert({ id: randomUUID(), workspace_id: wsA, actor_id: stranger.id, action: "form.created", resource_type: "form", resource_id: formA });
  if (!denied.error) throw new Error("outsider audit insert allowed");
});

// Run all gates, then clean up.
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
    for (const ws of [wsA, wsB]) await admin.from("workspaces").delete().eq("id", ws);
  } catch { /* best-effort cleanup */ }
  for (const u of users) {
    try {
      await admin.auth.admin.deleteUser(u.id);
    } catch { /* best-effort cleanup */ }
  }
}
console.log(failed === 0 ? "FORMS LIVE VERIFICATION: ALL GATES PASS" : `FORMS LIVE VERIFICATION: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
