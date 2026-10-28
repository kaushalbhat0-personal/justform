/**
 * Undo/redo is an EDITOR concern, not a database concern. The stack holds
 * canonical document snapshots; database revisions are never undo history.
 * Bounded (default 50), network-independent, secret-free (documents only).
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [] };
}

function equal<T>(a: T, b: T): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Commit a new present. No-op on deep-equal (avoids no-op history entries). Redo cleared. */
export function pushHistory<T>(history: History<T>, next: T, limit = 50): History<T> {
  if (equal(next, history.present)) return history;
  const past = [...history.past, history.present];
  while (past.length > limit) past.shift();
  return { past, present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(1) };
}
