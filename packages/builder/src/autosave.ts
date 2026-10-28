/**
 * Debounced autosave controller (framework-agnostic; the shell wires React).
 *
 * Contract with the OCC boundary:
 * - schedule(doc, baseRevision): marks dirty, restarts the debounce timer.
 *   Only the LATEST scheduled state is ever sent.
 * - flush(): save now (used by explicit Save / publish gating).
 * - Sequence numbers guard against stale responses: an older in-flight save
 *   that resolves after a newer one is ignored and can never overwrite state.
 * - Conflict is terminal for the attempt: local doc is preserved, the server
 *   revision is recorded, and the shell offers retry-on-latest or reload.
 * - retry(): re-attempt the preserved local doc against the latest known
 *   server revision (still OCC-guarded — a concurrent change conflicts again
 *   instead of silently overwriting).
 */
import type { CanonicalForm } from "@formos/forms-engine";

export type SaveStatus = "idle" | "dirty" | "pending" | "saving" | "saved" | "error" | "conflict";

export type SaveAttempt =
  | { ok: true; revision: number }
  | { ok: false; conflict: true; expectedRevision: number; currentRevision: number }
  | { ok: false; error: string };

export interface AutosaveEvents {
  onStatus: (status: SaveStatus, detail?: { error?: string; serverRevision?: number }) => void;
  onSaved: (revision: number) => void;
}

export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private pending: { doc: CanonicalForm; baseRevision: number } | null = null;
  private status: SaveStatus = "idle";
  private lastServerRevision: number;
  private readonly debounceMs: number;
  private readonly save: (doc: CanonicalForm, baseRevision: number) => Promise<SaveAttempt>;
  private readonly events: AutosaveEvents;
  private disposed = false;

  constructor(opts: {
    debounceMs: number;
    initialRevision: number;
    save: (doc: CanonicalForm, baseRevision: number) => Promise<SaveAttempt>;
    events: AutosaveEvents;
  }) {
    this.debounceMs = opts.debounceMs;
    this.lastServerRevision = opts.initialRevision;
    this.save = opts.save;
    this.events = opts.events;
  }

  getState(): SaveStatus {
    return this.status;
  }

  getServerRevision(): number {
    return this.lastServerRevision;
  }

  hasPendingEdits(): boolean {
    return this.pending !== null;
  }

  private setStatus(status: SaveStatus, detail?: { error?: string; serverRevision?: number }): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }

  /** Local edit arrived:dirty the controller and (re)start the debounce timer. */
  schedule(doc: CanonicalForm, baseRevision: number): void {
    if (this.disposed) return;
    this.pending = { doc, baseRevision };
    if (this.timer !== null) clearTimeout(this.timer);
    this.setStatus(this.status === "conflict" ? "conflict" : "dirty");
    if (this.status === "conflict") return; // conflicted edits wait for explicit retry/reload
    this.setStatus("pending");
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }

  /** Save the latest scheduled state now (explicit Save, publish gating). */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const attempt = this.pending;
    if (!attempt) return;
    this.pending = null;
    this.seq += 1;
    const seq = this.seq;
    this.setStatus("saving");
    let result: SaveAttempt;
    try {
      result = await this.save(attempt.doc, attempt.baseRevision);
    } catch (error) {
      if (seq !== this.seq) return; // superseded while in flight
      this.pending = attempt;
      this.setStatus("error", { error: error instanceof Error ? error.message : "Save failed." });
      return;
    }
    if (seq !== this.seq) return; // stale response: a newer attempt superseded this one
    if (result.ok) {
      this.lastServerRevision = result.revision;
      this.setStatus("saved");
      this.events.onSaved(result.revision);
      return;
    }
    if ("conflict" in result) {
      this.pending = attempt; // local edits preserved verbatim
      this.lastServerRevision = result.currentRevision;
      this.setStatus("conflict", { serverRevision: result.currentRevision });
      return;
    }
    this.pending = attempt;
    this.setStatus("error", { error: result.error });
  }

  /** Retry preserved local edits against the latest known server revision. */
  retry(): void {
    if (this.pending) {
      this.pending = { doc: this.pending.doc, baseRevision: this.lastServerRevision };
      this.setStatus("pending");
      void this.flush();
    }
  }

  /** Discard local edits in favor of a freshly loaded server document. */
  reload(serverRevision: number): void {
    this.pending = null;
    this.lastServerRevision = serverRevision;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setStatus("idle");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
