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

if (failures.length > 0) {
  console.log(`\n${failures.length} guard(s) failed`);
  process.exit(1);
}
console.log("\nall architecture guards passed");
