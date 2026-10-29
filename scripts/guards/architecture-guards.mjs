#!/usr/bin/env node
/**
 * Architecture guards (CI). Fail the build when frozen boundaries are violated.
 * Plain Node, zero dependencies, fast. Checks:
 *  G1 every tenant table has RLS enabled (+ FORCE) in migrations
 *  G2 no anon/authenticated INSERT/UPDATE/DELETE grants outside explicit RPC-shaped policies
 *      (heuristic: GRANT INSERT|UPDATE|DELETE TO anon|authenticated on tenant tables must
 *       be accompanied by an RLS policy on the same table — deny-by-default otherwise)
 *  G3 every SECURITY DEFINER function pins search_path
 *  G4 no service-role / secret names in browser-reachable code (apps/, packages/ui)
 *  G5 migrations use no extensions in the tenancy path (CREATE EXTENSION allowlist: none yet)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const failures = [];
const ok = (msg) => console.log(`ok   ${msg}`);
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};

const migrationDir = join(root, "supabase", "migrations");
const migrations = existsSync(migrationDir)
  ? readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()
  : [];
const sql = migrations.map((f) => readFileSync(join(migrationDir, f), "utf8")).join("\n");

// G1: every CREATE TABLE public.* has ENABLE ROW LEVEL SECURITY (+ FORCE).
const tables = [...sql.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);
for (const t of new Set(tables)) {
  const enabled = new RegExp(`ENABLE ROW LEVEL SECURITY[\\s\\S]{0,400}?${t}|${t}[\\s\\S]{0,400}?ENABLE ROW LEVEL SECURITY`);
  const hasEnable = sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
  const hasForce = sql.includes(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY`);
  if (hasEnable && hasForce) ok(`G1 RLS+FORCE on public.${t}`);
  else fail(`G1 public.${t} missing ENABLE/FORCE ROW LEVEL SECURITY`);
  void enabled;
}

// G2: direct DML grants to anon/authenticated on tenant tables require a same-table policy.
const grantRe = /GRANT\s+([\w,\s]+)\s+ON\s+(?:TABLE\s+)?public\.(\w+)\s+TO\s+(anon|authenticated|PUBLIC)/gi;
let m;
const dmlTables = new Map();
while ((m = grantRe.exec(sql)) !== null) {
  const verbs = m[1].toUpperCase();
  for (const v of ["INSERT", "UPDATE", "DELETE"]) {
    if (verbs.includes(v)) {
      if (!dmlTables.has(m[2])) dmlTables.set(m[2], new Set());
      dmlTables.get(m[2]).add(v);
    }
  }
}
for (const [t, verbs] of dmlTables) {
  const policyRe = new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+public\\.${t}`, "i");
  if (policyRe.test(sql)) ok(`G2 ${t} DML grants [${[...verbs].join(",")}] covered by RLS policy`);
  else fail(`G2 ${t} has direct ${[...verbs].join(",")} grant with no RLS policy`);
}

// G3: SECURITY DEFINER functions must pin search_path (evaluated per function block).
const blocks = sql.split(/(?=CREATE OR REPLACE FUNCTION\s+)/g).filter((b) => /CREATE OR REPLACE FUNCTION/.test(b));
const definerBlocks = blocks.filter((b) => /SECURITY DEFINER/.test(b));
const bad = definerBlocks.filter((b) => !/SET\s+search_path\s*=\s*pg_catalog\s*,\s*pg_temp/.test(b));
if (definerBlocks.length > 0 && bad.length === 0) {
  ok(`G3 all ${definerBlocks.length} SECURITY DEFINER functions pin search_path (pg_catalog, pg_temp)`);
} else if (definerBlocks.length === 0) {
  fail("G3 no SECURITY DEFINER functions found — expected RPC-gated control plane");
} else {
  const names = bad.map((b) => (b.match(/FUNCTION\s+([\w.]+)/) || [])[1] ?? "?");
  fail(`G3 search_path not hardened: ${names.join(", ")}`);
}

// G4: no secrets/service-role in browser-reachable trees.
const browserDirs = [join(root, "apps"), join(root, "packages", "ui")];
const secretRe = /SERVICE_ROLE|service_role|SUPABASE_SERVICE_ROLE|CRON_SECRET|INTAKE_DB_ROLE_PASSWORD|BILLING_PROVIDER_SECRET|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/;
for (const dir of browserDirs) {
  if (!existsSync(dir)) continue;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "coverage"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|css|json)$/.test(e.name)) {
        const c = readFileSync(p, "utf8");
        if (secretRe.test(c)) fail(`G4 secret/service-role reference in browser tree: ${p}`);
      }
    }
  };
  walk(dir);
}
ok("G4 browser trees clean of secrets/service-role");

// G5: no CREATE EXTENSION in migrations (portable-SQL rule; allowlist empty in Phase 0).
if (/CREATE EXTENSION/i.test(sql)) fail("G5 CREATE EXTENSION present — requires ADR exception");
else ok("G5 no extensions in migrations");

// G6: form-engine purity + renderer boundary (Phase 2).
// - schema.ts (canonical model) has zero imports (no React/RJSF/RHF/Zod/Next/Supabase/DB).
// - no executable-code surface: eval(, new Function(, dynamic import( in shipped
//   engine/renderer sources (tests may use static import only; the deliberate
//   AJV poison-stub is exempt and must only throw).
// - no AJV imports in shipped sources; no ajv in @formos/renderer dependencies.
// - @rjsf/* imports exist ONLY inside packages/renderer (ADR-003 boundary).
{
  const engineSrc = join(root, "packages", "forms-engine", "src");
  const rendererSrc = join(root, "packages", "renderer", "src");
  const rendererTests = join(root, "packages", "renderer", "tests");
  const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "coverage", ".turbo", "out"]);
  const readTree = (dir) => {
    const out = [];
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  const shipped = [...readTree(engineSrc), ...readTree(rendererSrc), ...readTree(rendererTests)];
  const schemaPath = join(engineSrc, "schema.ts");
  const schemaSrc = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
  if (/^\s*import\s/m.test(schemaSrc) || /require\s*\(/.test(schemaSrc)) {
    fail("G6 schema.ts must have zero imports (canonical purity)");
  } else ok("G6 schema.ts has zero imports");
  let executable = 0;
  for (const p of shipped) {
    const c = readFileSync(p, "utf8");
    const isAjvStub = p.endsWith(join("tests", "stubs", "validator-ajv8.ts"));
    if (/\beval\s*\(/.test(c) || /new\s+Function\s*\(/.test(c) || /import\s*\(/.test(c)) {
      fail(`G6 executable-code surface in shipped source: ${p}`);
      executable += 1;
    }
    if (!isAjvStub && (/from\s+["'][^"']*ajv/i.test(c) || /require\(\s*["'][^"']*ajv/i.test(c))) {
      fail(`G6 AJV import in shipped source: ${p}`);
      executable += 1;
    }
    if (isAjvStub && !/must never be used/.test(c)) {
      fail("G6 AJV poison-stub lost its throwing guard");
      executable += 1;
    }
  }
  if (executable === 0) ok("G6 no eval/new Function/dynamic import/AJV in shipped engine+renderer");
  try {
    const rendererPkg = JSON.parse(readFileSync(join(root, "packages", "renderer", "package.json"), "utf8"));
    const deps = { ...(rendererPkg.dependencies ?? {}), ...(rendererPkg.peerDependencies ?? {}) };
    if (Object.keys(deps).some((d) => /ajv/i.test(d))) fail("G6 ajv in @formos/renderer prod dependencies");
    else ok("G6 @formos/renderer prod dependencies AJV-free");
  } catch {
    fail("G6 cannot read packages/renderer/package.json");
  }
  const rjsfOutside = [];
  const scanDirs = [
    join(root, "apps"),
    join(root, "packages", "domain"),
    join(root, "packages", "auth"),
    join(root, "packages", "database"),
    join(root, "packages", "config"),
    join(root, "packages", "forms-engine"),
    join(root, "packages", "ui"),
    join(root, "scripts"),
  ];
  for (const dir of scanDirs) {
    for (const p of readTree(dir)) {
      const c = readFileSync(p, "utf8");
      if (/from\s+["']@rjsf\//.test(c) || /require\(\s*["']@rjsf\//.test(c) || /import\s+["']@rjsf\//.test(c)) {
        rjsfOutside.push(p);
      }
    }
  }
  if (rjsfOutside.length > 0) fail(`G6 @rjsf imports outside packages/renderer: ${rjsfOutside.join(", ")}`);
  else ok("G6 @rjsf imports contained in packages/renderer");
}

// G7: published snapshots are structurally immutable (Phase 4 invariant).
// form_versions must have: the immutability trigger, zero UPDATE/DELETE/ALL
// policies, and zero direct UPDATE/DELETE grants (writes flow via DEFINER RPC).
{
  const hasTrigger = /TRIGGER\s+form_versions_immutable/i.test(sql);
  const dmlPolicy = /CREATE\s+POLICY\s+\w+\s+ON\s+public\.form_versions\s+FOR\s+(UPDATE|DELETE|ALL)/i.test(sql);
  const dmlGrant = /GRANT\s+[^;]*\b(UPDATE|DELETE)\b[^;]*ON\s+(TABLE\s+)?public\.form_versions/i.test(sql);
  if (!hasTrigger) fail("G7 form_versions missing immutability trigger");
  else ok("G7 form_versions immutability trigger present");
  if (dmlPolicy) fail("G7 form_versions has UPDATE/DELETE/ALL policy — snapshots must be policy-immutable");
  else ok("G7 form_versions has no UPDATE/DELETE/ALL policy");
  if (dmlGrant) fail("G7 direct UPDATE/DELETE grant on form_versions — writes must be RPC-only");
  else ok("G7 form_versions has no direct UPDATE/DELETE grants");
}

// G8: builder + client boundaries (Phase 5 rules).
// - No client-side persistence substitutes: no localStorage/sessionStorage in
//   builder or web app sources (autosave goes through the OCC server boundary).
// - No second state/validation engines: no zustand/redux/react-hook-form/ajv
//   imports in builder or web sources (React state + generated Zod only).
// - The forms-engine package stays UI-free: no react/@rjsf imports there.
{
  const readTree = (dir) => {
    const out = [];
    const skip = new Set(["node_modules", "dist", ".next", "coverage", ".turbo", "out"]);
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
    };
    walk(dir);
    return out;
  };
  const clientDirs = [join(root, "packages", "builder"), join(root, "apps", "web")];
  const clientFiles = clientDirs.flatMap(readTree);
  let violations = 0;
  for (const p of clientFiles) {
    const c = readFileSync(p, "utf8");
    if (/\blocalStorage\b|\bsessionStorage\b/.test(c)) {
      fail(`G8 client persistence substitute in ${p} — drafts persist server-side only`);
      violations += 1;
    }
    if (/from\s+["'](zustand|redux|react-redux|react-hook-form|@reduxjs\/toolkit|ajv|@rjsf\/validator-ajv8)[^"']*["']/.test(c)) {
      fail(`G8 banned state/validation engine import in ${p}`);
      violations += 1;
    }
  }
  const engineFiles = readTree(join(root, "packages", "forms-engine", "src"));
  for (const p of engineFiles) {
    const c = readFileSync(p, "utf8");
    if (/from\s+["'](react|react-dom|@rjsf\/[^"']+)[^"']*["']/.test(c)) {
      fail(`G8 UI import in canonical forms-engine: ${p}`);
      violations += 1;
    }
  }
  if (violations === 0) ok("G8 builder/client boundaries hold (no storage substitutes, no parallel engines, UI-free engine)");
}

// G9: public intake lockdown (Phase 6 — frozen ARCH-FIX-002 boundary).
// - submissions/outbox: zero DML grants to anon/authenticated (RPC-only writes).
// - formos.submit_submission: no EXECUTE grant to anon/authenticated/PUBLIC,
//   and no public-schema wrapper (PostgREST serves only `public`, so no
//   browser can invoke it). The resolver intentionally stays public.
// - form_publications: no grants to anon (resolution is RPC-only).
// Phase 7 evolution: GRANT SELECT ON submissions TO authenticated is allowed
// (member inbox reads, RLS builder+ policy); DML stays forbidden and anon
// holds zero privileges of any kind.
{
  const grantLine = (t) => new RegExp(`GRANT[^;]*ON\\s+(?:TABLE\\s+)?public\\.${t}[^;]*TO[^;]*`, "gi");
  for (const t of ["submissions", "outbox"]) {
    const lines = sql.match(grantLine(t)) ?? [];
    const bad = lines.filter((l) => {
      const verbs = (l.split("ON")[0] ?? "").toUpperCase();
      const to = l.split("TO")[1] ?? "";
      if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/.test(verbs) && /\b(anon|authenticated|PUBLIC)\b/.test(to)) return true;
      if (/\bSELECT\b/.test(verbs) && /(^|[\s,])(anon|PUBLIC)\b/i.test(to)) return true;
      return false;
    });
    if (bad.length > 0) fail(`G9 public.${t} grants a forbidden privilege to anon/authenticated — writes are RPC-only, anon reads nothing`);
    else ok(`G9 public.${t} has no forbidden anon/authenticated grants`);
  }
  const execGrants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([\w.]+submit_submission[^\s]*)\s*\([^)]*\)\s*TO\s*([^;]+)/gi)];
  let execBad = 0;
  for (const g of execGrants) {
    const targets = g[2].split(",").map((s) => s.trim());
    if (targets.some((t) => /^(PUBLIC|anon|authenticated)$/i.test(t))) {
      fail(`G9 ${g[1]} EXECUTE granted to a browser role — intake RPC is intake_caller-only`);
      execBad += 1;
    }
    if (g[1].startsWith("public.")) {
      fail(`G9 ${g[1]} exposes the intake RPC in the PostgREST schema — browsers could invoke it`);
      execBad += 1;
    }
  }
  if (execGrants.length === 0) fail("G9 no EXECUTE grant found for submit_submission — intake_caller must hold exactly one");
  else if (execBad === 0) ok("G9 submit_submission EXECUTE is intake_caller-only with no public-schema surface");
  if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.submit_submission/i.test(sql)) {
    fail("G9 public.submit_submission wrapper exists — the intake RPC must have no PostgREST surface");
  } else ok("G9 no public.submit_submission wrapper");
  const pubLines = sql.match(grantLine("form_publications")) ?? [];
  const pubBad = pubLines.filter((l) => /(^|[\s,])anon\b/i.test(l.split("TO")[1] ?? ""));
  if (pubBad.length > 0) fail("G9 form_publications grants to anon — public resolution is RPC-only");
  else ok("G9 form_publications has no anon grants");
}

// G10: API/webhook secret hygiene (Phase 9).
// - api_keys/webhook_endpoints/webhook_deliveries: REVOKE ALL from
//   anon/authenticated, no browser policies, no direct DML/SELECT grants.
// - tick-pump DEFINER RPCs (tick_fanout/claim_deliveries/record_delivery)
//   are service_role-only with no public-schema wrapper.
// - client components ("use client") never touch secret hashes, encrypted
//   secrets, service clients, or the Authorization header.
// - no console.log/info/debug of secret-adjacent values in the API/webhook
//   request path.
{
  const grantLineAll = (t) => new RegExp(`GRANT[^;]*ON\\s+(?:TABLE\\s+)?public\\.${t}[^;]*TO[^;]*`, "gi");
  for (const t of ["api_keys", "webhook_endpoints", "webhook_deliveries"]) {
    const lines = sql.match(grantLineAll(t)) ?? [];
    const bad = lines.filter((l) => /(^|[\s,])(anon|authenticated|PUBLIC)\b/i.test(l.split("TO")[1] ?? ""));
    if (bad.length > 0) fail(`G10 public.${t} grants a privilege to a browser role — API/webhook storage is RPC/worker-only`);
    else ok(`G10 public.${t} has no browser-role grants`);
    const polRe = new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+public\\.${t}`, "i");
    if (polRe.test(sql)) fail(`G10 public.${t} has an RLS policy — API/webhook tables must stay policy-free (deny-by-default)`);
    else ok(`G10 public.${t} is policy-free`);
  }
  for (const fn of ["tick_fanout", "claim_deliveries", "record_delivery"]) {
    const grants = [...sql.matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+([\\w.]+${fn}[^\\s]*)\\s*\\([^)]*\\)\\s*TO\\s*([^;]+)`, "gi"))];
    if (grants.length === 0) {
      fail(`G10 no EXECUTE grant found for ${fn} — the tick pump must be service_role-only`);
      continue;
    }
    let bad = 0;
    for (const g of grants) {
      const targets = g[2].split(",").map((s) => s.trim());
      if (!targets.every((t) => /^service_role$/i.test(t))) {
        fail(`G10 ${g[1]} EXECUTE granted beyond service_role — tick internals must never be browser-invokable`);
        bad += 1;
      }
      if (g[1].startsWith("public.")) {
        fail(`G10 ${g[1]} exposes a tick RPC in the PostgREST schema`);
        bad += 1;
      }
    }
    if (bad === 0) ok(`G10 ${fn} EXECUTE is service_role-only with no public-schema surface`);
  }
  if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.(tick_fanout|claim_deliveries|record_delivery|new_uuid)/i.test(sql)) {
    fail("G10 public tick-pump wrapper exists — the worker surface must have no PostgREST entrypoint");
  } else ok("G10 no public tick-pump wrappers");
  const clientSecretRe = /secret_hash|secret_enc|service_role|SUPABASE_SERVICE_ROLE|CRON_SECRET|WEBHOOK_ENCRYPTION_KEY|INTAKE_DB_ROLE|getServiceClient|verifyApiKeyHash|decryptWebhookSecret|headers\.get\((["'])authorization\1\)/i;
  const clientHits = [];
  const walkClients = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "coverage"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walkClients(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) {
        const c = readFileSync(p, "utf8");
        if (/["']use client["']/.test(c.slice(0, 800)) && clientSecretRe.test(c)) clientHits.push(p);
      }
    }
  };
  walkClients(join(root, "apps"));
  if (clientHits.length > 0) fail(`G10 client components touch API/webhook secret material: ${clientHits.join(", ")}`);
  else ok("G10 client components are free of API/webhook secret material");
  const noisy = [];
  const walkLogs = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "coverage"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walkLogs(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (/console\.(log|debug|info)\s*\(/.test(line) && /secret|api[_-]?key|authorization|fullkey|payload|rawbody/i.test(line)) {
            noisy.push(`${p}:${i + 1}`);
          }
        });
      }
    }
  };
  for (const d of [join(root, "apps", "web", "lib", "api"), join(root, "apps", "web", "lib", "webhooks"), join(root, "apps", "web", "app", "api")]) {
    if (existsSync(d)) walkLogs(d);
  }
  if (noisy.length > 0) fail(`G10 secret-adjacent console logging in the API/webhook path: ${noisy.join(", ")}`);
  else ok("G10 no secret-adjacent console logging in the API/webhook path");
}

// G11: metering/billing boundaries (Phase 10, metering-only).
// - usage_events/plan_limits: REVOKE ALL from anon/authenticated, no
//   policies, no direct grants (RPC/worker-only writes, RPC-only reads).
// - workspaces UPDATE is column-restricted (name/slug): plan and billing
//   columns are not browser-writable.
// - quota trusted RPCs (check_quota/record_usage) are service_role-only with
//   no browser-role grants (public wrappers are service-key-only entrypoints).
// - int-test probes are dead in production (APP_ENV gate in every route).
// - no payment-provider code anywhere (no SDKs, no provider names).
{
  const grantLineAll = (t) => new RegExp(`GRANT[^;]*ON\\s+(?:TABLE\\s+)?public\\.${t}[^;]*TO[^;]*`, "gi");
  for (const t of ["usage_events", "plan_limits"]) {
    const lines = sql.match(grantLineAll(t)) ?? [];
    const bad = lines.filter((l) => /(^|[\s,])(anon|authenticated|PUBLIC)\b/i.test(l.split("TO")[1] ?? ""));
    if (bad.length > 0) fail(`G11 public.${t} grants a privilege to a browser role — metering storage is RPC-only`);
    else ok(`G11 public.${t} has no browser-role grants`);
    const polRe = new RegExp(`CREATE POLICY\\s+\\w+\\s+ON\\s+public\\.${t}`, "i");
    if (polRe.test(sql)) fail(`G11 public.${t} has an RLS policy — metering tables must stay policy-free`);
    else ok(`G11 public.${t} is policy-free`);
  }
  const wsGrants = sql.match(grantLineAll("workspaces")) ?? [];
  const wsUpdates = wsGrants.filter((l) => /\bUPDATE\b/i.test(l.split("ON")[0] ?? ""));
  const wsLast = wsUpdates[wsUpdates.length - 1];
  if (!wsLast) fail("G11 no UPDATE grant found on workspaces");
  else if (!/UPDATE\s*\(\s*name\s*,\s*slug\s*\)/i.test(wsLast)) {
    fail("G11 workspaces UPDATE is not column-restricted to (name, slug) — plan/billing columns must not be browser-writable");
  } else ok("G11 workspaces UPDATE is column-restricted to (name, slug)");
  // Trusted metering RPCs: control plane + public wrapper are service_role-only.
  // Member RPCs: check_quota_member is authenticated-only; get_usage_summary
  // is authenticated + service_role; anon/PUBLIC never appear.
  const execTargets = (fn) =>
    [...sql.matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+([\\w.]+${fn}[^\\s]*)\\s*\\([^)]*\\)\\s*TO\\s*([^;]+)`, "gi"))];
  for (const fn of ["check_quota", "record_usage"]) {
    const grants = [...sql.matchAll(new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+([\\w.]+${fn}[^\\s]*)\\s*\\([^)]*\\)\\s*TO\\s*([^;]+)`, "gi"))];
    if (grants.length === 0) {
      fail(`G11 no EXECUTE grant found for ${fn}`);
      continue;
    }
    const scoped = grants.filter((g) => g[1] === `formos.${fn}` || g[1] === `public.${fn}`);
    if (scoped.length === 0) {
      fail(`G11 no formos/public grant found for ${fn}`);
      continue;
    }
    const bad = scoped.filter((g) => !g[2].split(",").map((x) => x.trim()).every((t) => /^service_role$/i.test(t)));
    if (bad.length > 0) fail(`G11 trusted ${fn} granted beyond service_role — trusted metering must never be browser-invokable`);
    else ok(`G11 trusted ${fn} entrypoints are service_role-only`);
  }
  {
    const member = execTargets("check_quota_member");
    const toAuth = member.some((g) => /(^|[\s,])authenticated\b/i.test(g[2]));
    const toAnon = member.some((g) => /(^|[\s,])(anon|PUBLIC)\b/i.test(g[2]));
    if (!toAuth || toAnon) fail("G11 check_quota_member must be authenticated-only");
    else ok("G11 check_quota_member is authenticated-only");
    const summary = execTargets("get_usage_summary");
    const sAuth = summary.some((g) => /(^|[\s,])authenticated\b/i.test(g[2]));
    const sSvc = summary.some((g) => /(^|[\s,])service_role\b/i.test(g[2]));
    const sAnon = summary.some((g) => /(^|[\s,])(anon|PUBLIC)\b/i.test(g[2]));
    if (!sAuth || !sSvc || sAnon) fail("G11 get_usage_summary must be authenticated + service_role only");
    else ok("G11 get_usage_summary is authenticated + service_role only");
  }
  for (const f of ["apps/web/app/api/int-test/inbox/route.ts", "apps/web/app/api/int-test/tables/route.ts"]) {
    const p = join(root, f);
    if (!existsSync(p)) {
      fail(`G11 ${f} missing`);
      continue;
    }
    const c = readFileSync(p, "utf8");
    if (!/APP_ENV.*production|production.*APP_ENV/.test(c) || !/x-verify-secret/.test(c)) {
      fail(`G11 ${f} lacks the production kill-switch and/or scheduler-secret gate`);
    } else ok(`G11 ${f} is production-gated and secret-gated`);
  }
  const payHits = [];
  const payRe = /stripe|razorpay|paddle|paypal|braintree|checkout\.com|chargebee|lemonsqueezy/i;
  const walkPay = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "coverage", ".turbo", "out"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walkPay(p);
      else if (/\.(ts|tsx|js|mjs|json)$/.test(e.name) && !/package-lock\.json$/.test(e.name)) {
        const c = readFileSync(p, "utf8");
        // package.json files: only flag actual payment dependencies, not prose.
        if (e.name === "package.json") {
          try {
            const deps = { ...JSON.parse(c).dependencies, ...JSON.parse(c).devDependencies };
            for (const k of Object.keys(deps)) if (payRe.test(k)) payHits.push(`${p} :: ${k}`);
          } catch { /* ignore unparsable */ }
        } else if (payRe.test(c)) {
          // prose mentions (comments/docs) are allowed; code references are not.
          const lines = c.split("\n").filter((l) => payRe.test(l) && !/^\s*(\/\/|#|\*|<!--)/.test(l) && !/metering-only|no .*payments|never|NOT implement/i.test(l));
          if (lines.length > 0) payHits.push(`${p} :: ${lines[0].trim().slice(0, 80)}`);
        }
      }
    }
  };
  walkPay(join(root, "apps"));
  walkPay(join(root, "packages"));
  if (payHits.length > 0) fail(`G11 payment-provider code present: ${payHits.join("; ")}`);
  else ok("G11 no payment-provider code or dependencies");
}

// G12: workflow foundation lockdown (Phase 11).
// - workflow_definitions/versions/instances/tasks: RLS+FORCE (covered by G1),
//   SELECT-only grants to authenticated (reads are member RLS-gated), zero
//   INSERT/UPDATE/DELETE grants (writes are DEFINER-RPC-only).
// - workflow_versions carry the immutability trigger (same rule as form_versions).
// - internal starter formos.start_workflow_for_submission is callable only by
//   intake_caller + service_role (no browser/authenticated grant, no public wrapper).
{
  const grantLineAll = (t) => new RegExp(`GRANT[^;]*ON\\s+(?:TABLE\\s+)?public\\.${t}[^;]*TO[^;]*`, "gi");
  for (const t of ["workflow_definitions", "workflow_versions", "workflow_instances", "workflow_tasks"]) {
    const lines = sql.match(grantLineAll(t)) ?? [];
    const bad = lines.filter((l) => {
      const verbs = (l.split("ON")[0] ?? "").toUpperCase();
      const to = l.split("TO")[1] ?? "";
      if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/.test(verbs) && /\b(anon|authenticated|PUBLIC)\b/.test(to)) return true;
      if (/\bSELECT\b/.test(verbs) && /(^|[\s,])(anon|PUBLIC)\b/i.test(to)) return true;
      return false;
    });
    if (bad.length > 0) fail(`G12 public.${t} grants a forbidden privilege — workflow writes are RPC-only, anon reads nothing`);
    else ok(`G12 public.${t} has no forbidden grants`);
  }
  if (!/TRIGGER\s+workflow_versions_immutable/i.test(sql)) fail("G12 workflow_versions missing immutability trigger");
  else ok("G12 workflow_versions immutability trigger present");
  if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.start_workflow_for_submission/i.test(sql)) {
    fail("G12 public.start_workflow_for_submission wrapper exists — the internal starter must have no PostgREST surface");
  } else ok("G12 no public.start_workflow_for_submission wrapper");
  const starter = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+formos\.start_workflow_for_submission\s*\([^)]*\)\s*TO\s*([^;]+)/gi)];
  const starterBad = starter.some((g) => !g[1].split(",").map((s) => s.trim()).every((x) => /^(intake_caller|service_role)$/i.test(x)));
  if (starter.length === 0) fail("G12 no EXECUTE grant found for start_workflow_for_submission");
  else if (starterBad) fail("G12 start_workflow_for_submission granted beyond intake_caller/service_role");
  else ok("G12 start_workflow_for_submission is intake_caller/service_role-only");
}

// G13: authorized workspace teardown (Phase 12).
// - formos.delete_workspace exists; thin public.delete_workspace wrapper exists
//   (PostgREST surface for the BFF/server action).
// - EXECUTE on formos.delete_workspace is authenticated/service_role-only;
//   public wrapper is authenticated-only (anon holds nothing).
// - formos.teardown_context (the bypass switch) carries no EXECUTE grant to
//   any caller — only delete_workspace invokes it in-transaction.
// - Both version immutability triggers honor the teardown context instead of
//   being removed; owner-only error text is present in delete_workspace.
{
  if (!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+formos\.delete_workspace\s*\(/i.test(sql)) {
    fail("G13 formos.delete_workspace is missing");
  } else ok("G13 formos.delete_workspace exists");
  if (!/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.delete_workspace\s*\(/i.test(sql)) {
    fail("G13 public.delete_workspace wrapper is missing");
  } else ok("G13 public.delete_workspace wrapper exists");
  const dwGrants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+formos\.delete_workspace\s*\([^)]*\)\s*TO\s*([^;]+)/gi)];
  const dwBad = dwGrants.some((g) => !g[1].split(",").map((s) => s.trim()).every((x) => /^(authenticated|service_role)$/i.test(x)));
  if (dwGrants.length === 0) fail("G13 no EXECUTE grant found for formos.delete_workspace");
  else if (dwBad) fail("G13 formos.delete_workspace granted beyond authenticated/service_role");
  else ok("G13 formos.delete_workspace is authenticated/service_role-only");
  const pubDwGrants = [...sql.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.delete_workspace\s*\([^)]*\)\s*TO\s*([^;]+)/gi)];
  const pubDwBad = pubDwGrants.some((g) => !g[1].split(",").map((s) => s.trim()).every((x) => /^authenticated$/i.test(x)));
  if (pubDwGrants.length === 0) fail("G13 no EXECUTE grant found for public.delete_workspace");
  else if (pubDwBad) fail("G13 public.delete_workspace granted beyond authenticated");
  else ok("G13 public.delete_workspace is authenticated-only");
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+formos\.teardown_context/i.test(sql)) {
    fail("G13 formos.teardown_context must carry no EXECUTE grant (delete_workspace-only)");
  } else ok("G13 formos.teardown_context carries no EXECUTE grant");
  const triggerBodies = [...sql.matchAll(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+formos\.prevent_(workflow_)?version_mutation\(\)[\s\S]*?\$\$;/gi)];
  const scoped = triggerBodies.filter((m) => /teardown_context\(\)/.test(m[0]));
  if (scoped.length < 2) fail("G13 version immutability triggers must honor teardown_context (form + workflow)");
  else ok("G13 version immutability triggers honor teardown_context");
  if (!/workspace deletion requires workspace owner/i.test(sql)) fail("G13 delete_workspace owner check is missing");
  else ok("G13 delete_workspace enforces workspace owner");
}

if (failures.length > 0) {
  console.log(`\n${failures.length} guard(s) failed`);
  process.exit(1);
}
console.log("\nall architecture guards passed");
