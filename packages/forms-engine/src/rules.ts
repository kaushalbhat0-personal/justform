/**
 * Rules: declarative condition evaluation + reference validation + cycle strategy.
 *
 * Scope (S2 spike): the canonical schema must PROVE that visibility /
 * requiredness can be represented without executable code — not implement the
 * full rules engine. This module provides the pure interpreter core the
 * respondent renderer and the (later) builder preview share:
 * - reference validation (every field/page ref resolves; ids stable)
 * - cycle DETECTION strategy (conservative: report, don't silently order)
 * - pure condition/group evaluation over normalized values by stable `key`
 * - field-state resolution (visible + required per key)
 */
import type { CanonicalForm, Condition, ConditionGroup, Rule } from "./schema.js";
import { indexFieldsByKey } from "./parse.js";

export type RuleProblems = { errors: string[]; cycleWarnings: string[][] };

function valuesOf(values: Record<string, unknown>, key: string): unknown {
  return values[key];
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function compareNumbers(a: unknown, b: unknown): number | null {
  const x = typeof a === "string" && a !== "" ? Number(a) : typeof a === "number" ? a : NaN;
  const y = typeof b === "string" && b !== "" ? Number(b) : typeof b === "number" ? b : NaN;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Pure condition evaluation over normalized values. No I/O, no eval. */
export function evaluateCondition(condition: Condition, values: Record<string, unknown>): boolean {
  const actual = valuesOf(values, condition.field);
  switch (condition.op) {
    case "empty":
      return isEmpty(actual);
    case "not_empty":
      return !isEmpty(actual);
    case "eq":
      return actual === condition.value;
    case "neq":
      return actual !== condition.value;
    case "contains":
      if (typeof actual === "string" && typeof condition.value === "string") return actual.includes(condition.value);
      if (Array.isArray(actual)) return actual.includes(condition.value);
      return false;
    case "not_contains":
      if (typeof actual === "string" && typeof condition.value === "string") return !actual.includes(condition.value);
      if (Array.isArray(actual)) return !actual.includes(condition.value);
      return true;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "not_in":
      return Array.isArray(condition.value) && !condition.value.includes(actual);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const cmp = compareNumbers(actual, condition.value);
      if (cmp === null) return false;
      if (condition.op === "gt") return cmp > 0;
      if (condition.op === "gte") return cmp >= 0;
      if (condition.op === "lt") return cmp < 0;
      return cmp <= 0;
    }
    default:
      return false;
  }
}

export function evaluateConditionGroup(group: ConditionGroup, values: Record<string, unknown>): boolean {
  if ("all" in group) return group.all.every((c) => evaluateCondition(c, values));
  return group.any.some((c) => evaluateCondition(c, values));
}

export function evaluateRule(rule: Rule, values: Record<string, unknown>): boolean {
  return evaluateConditionGroup(rule.if, values);
}

export interface FieldState {
  visible: boolean;
  required: boolean;
}

/**
 * Resolve per-field visibility/requiredness.
 * Base: visible unless statically `hidden`; required per static `required`.
 * Matching `hide` rules conceal; a field targeted by ANY `show` rule is shown
 * only while at least one of its `show` rules matches (explicit opt-in).
 * Matching `require` rules force required; matching `optional` rules relax it.
 */
export function resolveFieldState(form: CanonicalForm, values: Record<string, unknown>): Map<string, FieldState> {
  const byKey = indexFieldsByKey(form);
  const state = new Map<string, FieldState>();
  for (const key of byKey.keys()) {
    const field = byKey.get(key);
    state.set(key, { visible: field?.hidden !== true, required: field?.required === true });
  }
  const showTargets = new Set<string>();
  for (const rule of form.rules) {
    for (const action of rule.actions) {
      if (action.kind === "show") showTargets.add(action.target);
    }
  }
  for (const target of showTargets) {
    const current = state.get(target);
    if (current) current.visible = false;
  }
  for (const rule of form.rules) {
    if (!evaluateRule(rule, values)) continue;
    for (const action of rule.actions) {
      const current = state.get(action.target);
      if (!current) continue;
      if (action.kind === "show") current.visible = true;
      else if (action.kind === "hide") current.visible = false;
      else if (action.kind === "require") current.required = true;
      else if (action.kind === "optional") current.required = false;
    }
  }
  return state;
}

/**
 * Reference validation + cycle detection strategy.
 * - Hard errors: unknown field/page refs, duplicate rule ids (also in parse),
 *   `set` actions without a serializable value.
 * - Cycle warnings: conservative DFS over the field-dependency graph where an
 *   edge A→B means "rule reads A and writes/shows B". A cycle means two fields
 *   gate each other — flagged for author review, never executed in a loop
 *   (resolution above is a single fixed-point-free pass).
 */
export function validateRules(form: CanonicalForm): RuleProblems {
  const errors: string[] = [];
  const byKey = indexFieldsByKey(form);
  const pageKeys = new Set(form.pages.map((p) => p.key));
  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const set = adjacency.get(from) ?? new Set<string>();
    set.add(to);
    adjacency.set(from, set);
  };
  for (const rule of form.rules) {
    const conds = "all" in rule.if ? rule.if.all : rule.if.any;
    for (const cond of conds) {
      if (!byKey.has(cond.field)) errors.push(`rule ${rule.id} conditions unknown field key: ${cond.field}`);
    }
    for (const action of rule.actions) {
      if (action.kind === "goto_page") {
        if (!pageKeys.has(action.target)) errors.push(`rule ${rule.id} targets unknown page key: ${action.target}`);
        continue;
      }
      if (!byKey.has(action.target)) {
        errors.push(`rule ${rule.id} targets unknown field key: ${action.target}`);
        continue;
      }
      if (action.kind === "set" && (action.value === undefined || typeof action.value === "function")) {
        errors.push(`rule ${rule.id} set action requires a serializable value`);
      }
      if (action.kind === "set" && action.value !== undefined) {
        try {
          JSON.stringify(action.value);
        } catch {
          errors.push(`rule ${rule.id} set action value is not serializable`);
        }
      }
      for (const cond of conds) link(cond.field, action.target);
    }
  }
  // Conservative cycle detection (iterative DFS).
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
        const cycle = [...top.path.slice(top.path.indexOf(node)), node];
        cycleWarnings.push(cycle);
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
