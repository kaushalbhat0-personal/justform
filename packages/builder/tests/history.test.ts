import { describe, expect, it } from "vitest";
import { canRedo, canUndo, createHistory, pushHistory, redoHistory, undoHistory } from "../src/history.js";

describe("history: undo/redo boundaries", () => {
  it("undoes and redoes document states", () => {
    let h = createHistory({ v: 0 });
    h = pushHistory(h, { v: 1 });
    h = pushHistory(h, { v: 2 });
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    h = undoHistory(h);
    expect(h.present).toEqual({ v: 1 });
    expect(canRedo(h)).toBe(true);
    h = undoHistory(h);
    expect(h.present).toEqual({ v: 0 });
    expect(canUndo(h)).toBe(false);
    h = redoHistory(h);
    expect(h.present).toEqual({ v: 1 });
    h = redoHistory(h);
    expect(h.present).toEqual({ v: 2 });
    expect(canRedo(h)).toBe(false);
  });

  it("new edits clear redo; equal states do not push", () => {
    let h = createHistory("a");
    h = pushHistory(h, "b");
    h = undoHistory(h);
    expect(canRedo(h)).toBe(true);
    h = pushHistory(h, "c");
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe("c");
    const same = pushHistory(h, "c");
    expect(same.past).toHaveLength(h.past.length);
  });

  it("is bounded and network-independent", () => {
    let h = createHistory(0);
    for (let i = 1; i <= 60; i += 1) h = pushHistory(h, i, 50);
    expect(h.past).toHaveLength(50);
    expect(h.present).toBe(60);
  });

  it("undo/redo at boundaries are safe no-ops", () => {
    const h = createHistory("x");
    expect(undoHistory(h).present).toBe("x");
    expect(redoHistory(h).present).toBe("x");
  });
});
