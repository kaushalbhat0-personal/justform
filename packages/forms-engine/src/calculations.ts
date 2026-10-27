/**
 * Calculations: serializable AST representation + pure bounded evaluator.
 *
 * Scope (S2 spike): prove the canonical schema can REPRESENT calculations
 * without embedding executable code — not the full engine. The evaluator here
 * is the same allowlisted core the later engine grows: AST-only input, no
 * `eval`, no `new Function`, a 1000-step cap, and total (never throwing)
 * error results for invalid/cyclic references.
 */
import type { CalcNode, CanonicalForm } from "./schema.js";
import { indexFieldsByKey } from "./parse.js";

export const CALC_STEP_CAP = 1000;

export type CalcValue = number | string | boolean;
export type CalcResult = { ok: true; value: CalcValue } | { ok: false; error: string };

function err(error: string): CalcResult {
  return { ok: false, error };
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isTruthy(value: CalcValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== "";
}

class Steps {
  count = 0;
  tick(): boolean {
    this.count += 1;
    return this.count <= CALC_STEP_CAP;
  }
}

function evaluateNode(node: CalcNode, values: Record<string, unknown>, steps: Steps): CalcResult {
  if (!steps.tick()) return err("step cap exceeded");
  switch (node.kind) {
    case "lit":
      return { ok: true, value: node.value };
    case "ref": {
      const raw = values[node.field];
      if (raw === undefined || raw === null) return err(`unresolved reference: ${node.field}`);
      if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") {
        return { ok: true, value: raw };
      }
      return err(`non-scalar reference: ${node.field}`);
    }
    case "binary": {
      const left = evaluateNode(node.left, values, steps);
      if (!left.ok) return left;
      const right = evaluateNode(node.right, values, steps);
      if (!right.ok) return right;
      const l = left.value;
      const r = right.value;
      if (node.op === "==") return { ok: true, value: l === r };
      if (node.op === "!=") return { ok: true, value: l !== r };
      if (node.op === ">" || node.op === ">=" || node.op === "<" || node.op === "<=") {
        const ln = toNumber(l);
        const rn = toNumber(r);
        if (ln === null || rn === null) return err("comparison requires numeric operands");
        if (node.op === ">") return { ok: true, value: ln > rn };
        if (node.op === ">=") return { ok: true, value: ln >= rn };
        if (node.op === "<") return { ok: true, value: ln < rn };
        return { ok: true, value: ln <= rn };
      }
      const ln = toNumber(l);
      const rn = toNumber(r);
      if (ln === null || rn === null) return err("arithmetic requires numeric operands");
      if (node.op === "+") return { ok: true, value: ln + rn };
      if (node.op === "-") return { ok: true, value: ln - rn };
      if (node.op === "*") return { ok: true, value: ln * rn };
      if (node.op === "/") {
        if (rn === 0) return err("division by zero");
        return { ok: true, value: ln / rn };
      }
      if (node.op === "%") {
        if (rn === 0) return err("division by zero");
        return { ok: true, value: ln % rn };
      }
      return err(`unsupported operator: ${node.op}`);
    }
    case "call": {
      const args: CalcValue[] = [];
      for (const arg of node.args) {
        const evaluated = evaluateNode(arg, values, steps);
        if (!evaluated.ok) return evaluated;
        args.push(evaluated.value);
      }
      return evaluateCall(node.fn, args);
    }
  }
}

function evaluateCall(
  fn: "SUM" | "AVG" | "MIN" | "MAX" | "ROUND" | "IF" | "CONCAT" | "DATE_DIFF",
  args: CalcValue[],
): CalcResult {
  switch (fn) {
    case "SUM":
    case "AVG":
    case "MIN":
    case "MAX": {
      const nums: number[] = [];
      for (const a of args) {
        const n = toNumber(a);
        if (n === null) return err(`${fn} requires numeric arguments`);
        nums.push(n);
      }
      if (nums.length === 0) return err(`${fn} requires at least one argument`);
      if (fn === "SUM") return { ok: true, value: nums.reduce((x, y) => x + y, 0) };
      if (fn === "AVG") return { ok: true, value: nums.reduce((x, y) => x + y, 0) / nums.length };
      if (fn === "MIN") return { ok: true, value: Math.min(...nums) };
      return { ok: true, value: Math.max(...nums) };
    }
    case "ROUND": {
      if (args.length < 1 || args.length > 2) return err("ROUND takes (value[, digits])");
      const n = toNumber(args[0]);
      const digits = args.length === 2 ? toNumber(args[1]) : 0;
      if (n === null || digits === null || !Number.isInteger(digits) || digits < 0 || digits > 10) {
        return err("ROUND takes (value[, digits 0..10])");
      }
      const factor = 10 ** digits;
      return { ok: true, value: Math.round(n * factor) / factor };
    }
    case "IF": {
      if (args.length !== 3) return err("IF takes (condition, then, else)");
      const cond = args[0];
      if (cond === undefined) return err("IF takes (condition, then, else)");
      return { ok: true, value: isTruthy(cond as CalcValue) ? (args[1] as CalcValue) : (args[2] as CalcValue) };
    }
    case "CONCAT":
      return { ok: true, value: args.map((a) => String(a)).join("") };
    case "DATE_DIFF": {
      if (args.length !== 2) return err("DATE_DIFF takes (startDate, endDate) as YYYY-MM-DD");
      const [s, e] = args;
      if (typeof s !== "string" || typeof e !== "string") return err("DATE_DIFF takes YYYY-MM-DD strings");
      const start = Date.parse(`${s}T00:00:00Z`);
      const end = Date.parse(`${e}T00:00:00Z`);
      if (Number.isNaN(start) || Number.isNaN(end)) return err("DATE_DIFF takes valid YYYY-MM-DD strings");
      return { ok: true, value: Math.round((end - start) / 86_400_000) };
    }
  }
}

/** Collect every `ref` field key in an expression (dependency analysis). */
export function collectRefs(node: CalcNode): string[] {
  if (node.kind === "ref") return [node.field];
  if (node.kind === "lit") return [];
  if (node.kind === "binary") return [...collectRefs(node.left), ...collectRefs(node.right)];
  return node.args.flatMap(collectRefs);
}

/**
 * Validate calculation declarations: targets/refs resolve to declared keys,
 * declared `deps` equal the referenced set (exact, sorted comparison), and no
 * calculation writes a field another calculation depends on in a cycle.
 */
export function validateCalculations(form: CanonicalForm): { errors: string[]; cycleWarnings: string[][] } {
  const errors: string[] = [];
  const byKey = indexFieldsByKey(form);
  const producers = new Map<string, string>();
  for (const calc of form.calculations) {
    if (!byKey.has(calc.target)) {
      errors.push(`calculation ${calc.id} targets unknown field key: ${calc.target}`);
      continue;
    }
    const prior = producers.get(calc.target);
    if (prior !== undefined) errors.push(`calculations ${prior} and ${calc.id} both target ${calc.target}`);
    else producers.set(calc.target, calc.id);
    for (const ref of collectRefs(calc.expression)) {
      if (!byKey.has(ref)) errors.push(`calculation ${calc.id} references unknown field key: ${ref}`);
    }
  }
  // Dependency cycles between calculations (target → refs that are themselves targets).
  const adjacency = new Map<string, Set<string>>();
  for (const calc of form.calculations) {
    const depsOnCalcs = collectRefs(calc.expression).filter((r) => producers.has(r));
    adjacency.set(calc.target, new Set(depsOnCalcs));
  }
  const cycleWarnings: string[][] = [];
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const stack: Array<{ node: string; path: string[]; it: Iterator<string> }> = [
      { node: start, path: [start], it: (adjacency.get(start) ?? new Set()).values() },
    ];
    const inStack = new Set([start]);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const next = top.it.next();
      if (next.done === true) {
        stack.pop();
        inStack.delete(top.node);
        visited.add(top.node);
        continue;
      }
      const node = next.value as string;
      if (inStack.has(node)) {
        cycleWarnings.push([...top.path.slice(top.path.indexOf(node)), node]);
        continue;
      }
      if (!visited.has(node)) {
        inStack.add(node);
        stack.push({ node, path: [...top.path, node], it: (adjacency.get(node) ?? new Set()).values() });
      }
    }
  }
  return { errors, cycleWarnings };
}

/**
 * Evaluate every calculation in topological order. Cyclic targets resolve to
 * per-calc errors (never a hang); refs missing from values resolve to precise
 * node-level "unresolved reference" errors.
 */
export function evaluateCalculations(
  form: CanonicalForm,
  values: Record<string, unknown>,
): Map<string, CalcResult> {
  const results = new Map<string, CalcResult>();
  const targets = new Map(form.calculations.map((c) => [c.target, c]));
  const depCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const calc of form.calculations) {
    const calcDeps = [...new Set(collectRefs(calc.expression))].filter((r) => targets.has(r) && r !== calc.target);
    depCount.set(calc.target, calcDeps.length);
    for (const d of calcDeps) dependents.set(d, [...(dependents.get(d) ?? []), calc.target]);
  }
  const queue = form.calculations.filter((c) => (depCount.get(c.target) ?? 0) === 0).map((c) => c.target);
  const merged: Record<string, unknown> = { ...values };
  const ordered: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    ordered.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const n = (depCount.get(dependent) ?? 1) - 1;
      depCount.set(dependent, n);
      if (n === 0) queue.push(dependent);
    }
  }
  for (const target of ordered) {
    const calc = targets.get(target);
    if (!calc) continue;
    const result = evaluateNode(calc.expression, merged, new Steps());
    results.set(target, result);
    if (result.ok) merged[target] = result.value;
  }
  for (const calc of form.calculations) {
    if (!results.has(calc.target)) {
      results.set(calc.target, err(`cyclic dependencies for target: ${calc.target}`));
    }
  }
  return results;
}
