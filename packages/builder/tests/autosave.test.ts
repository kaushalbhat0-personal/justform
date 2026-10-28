import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AutosaveController, type SaveAttempt } from "../src/autosave.js";
import type { CanonicalForm } from "@formos/forms-engine";

const doc = (marker: string): CanonicalForm =>
  ({
    id: marker,
    key: "k",
    schemaVersion: 1,
    rendererVersion: "r",
    metadata: { title: "T" },
    settings: {},
    pages: [],
    rules: [],
    calculations: [],
    localization: {},
    notificationsRef: null,
    integrationsRef: null,
  }) as CanonicalForm;

describe("autosave: debounce + save lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces rapid edits into one save of the latest state", async () => {
    const seen: Array<{ doc: CanonicalForm; base: number }> = [];
    const save = vi.fn(async (d: CanonicalForm, base: number): Promise<SaveAttempt> => {
      seen.push({ doc: d, base });
      return { ok: true, revision: 2 };
    });
    const states: string[] = [];
    const controller = new AutosaveController({
      debounceMs: 1000,
      initialRevision: 1,
      save,
      events: { onStatus: (s) => states.push(s), onSaved: () => {} },
    });
    controller.schedule(doc("a"), 1);
    controller.schedule(doc("b"), 1);
    controller.schedule(doc("c"), 1);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.doc).toEqual(doc("c"));
    controller.dispose();
  });

  it("successful save updates the known server revision", async () => {
    const save = vi.fn(async (): Promise<SaveAttempt> => ({ ok: true, revision: 5 }));
    const saved: number[] = [];
    const controller = new AutosaveController({
      debounceMs: 500,
      initialRevision: 4,
      save,
      events: { onStatus: () => {}, onSaved: (r) => saved.push(r) },
    });
    controller.schedule(doc("a"), 4);
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual([5]);
    expect(controller.getServerRevision()).toBe(5);
    expect(controller.getState()).toBe("saved");
    controller.dispose();
  });

  it("failed save preserves pending edits and surfaces error with retry", async () => {
    let calls = 0;
    const save = vi.fn(async (): Promise<SaveAttempt> => {
      calls += 1;
      return calls === 1 ? { ok: false, error: "boom" } : { ok: true, revision: 2 };
    });
    const states: string[] = [];
    const controller = new AutosaveController({
      debounceMs: 500,
      initialRevision: 1,
      save,
      events: { onStatus: (s) => states.push(s), onSaved: () => {} },
    });
    controller.schedule(doc("a"), 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getState()).toBe("error");
    expect(controller.hasPendingEdits()).toBe(true);
    await controller.flush();
    expect(controller.getState()).toBe("saved");
    expect(states).toContain("error");
    controller.dispose();
  });

  it("stale responses never overwrite newer state", async () => {
    const releases: Array<(v: SaveAttempt) => void> = [];
    const save = vi.fn(
      () =>
        new Promise<SaveAttempt>((resolve) => {
          releases.push(resolve);
        }),
    );
    const saved: number[] = [];
    const controller = new AutosaveController({
      debounceMs: 500,
      initialRevision: 1,
      save,
      events: { onStatus: () => {}, onSaved: (r) => saved.push(r) },
    });
    controller.schedule(doc("a"), 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    // Second attempt resolves immediately; the first stays pending (stale).
    save.mockImplementationOnce(async () => ({ ok: true, revision: 9 }));
    controller.schedule(doc("b"), 1);
    await controller.flush();
    expect(saved).toEqual([9]);
    // Now the stale first attempt resolves late with an older revision.
    releases[0]?.({ ok: true, revision: 2 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual([9]);
    expect(controller.getServerRevision()).toBe(9);
    controller.dispose();
  });

  it("conflict preserves local edits and records the server revision", async () => {
    const seen: Array<{ doc: CanonicalForm; base: number }> = [];
    const save = vi.fn(async (d: CanonicalForm, base: number): Promise<SaveAttempt> => {
      seen.push({ doc: d, base });
      return { ok: false, conflict: true, expectedRevision: 1, currentRevision: 7 };
    });
    const controller = new AutosaveController({
      debounceMs: 200,
      initialRevision: 1,
      save,
      events: { onStatus: () => {}, onSaved: () => {} },
    });
    controller.schedule(doc("local"), 1);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.getState()).toBe("conflict");
    expect(controller.getServerRevision()).toBe(7);
    expect(controller.hasPendingEdits()).toBe(true);
    // Retry re-attempts the SAME local doc against the latest revision.
    controller.retry();
    await vi.advanceTimersByTimeAsync(0);
    const last = seen[seen.length - 1];
    expect(last?.doc).toEqual(doc("local"));
    expect(last?.base).toBe(7);
    controller.dispose();
  });

  it("flush with nothing scheduled is a no-op; dispose stops timers", async () => {
    const save = vi.fn(async (): Promise<SaveAttempt> => ({ ok: true, revision: 1 }));
    const controller = new AutosaveController({
      debounceMs: 100,
      initialRevision: 1,
      save,
      events: { onStatus: () => {}, onSaved: () => {} },
    });
    await controller.flush();
    expect(save).not.toHaveBeenCalled();
    controller.schedule(doc("a"), 1);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
