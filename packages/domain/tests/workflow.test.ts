import { describe, expect, it } from "vitest";
import {
  canDecideTask,
  canTransitionTask,
  instanceStatusForOutcome,
  normalizeWorkflowConfig,
  validateWorkflowConfig,
} from "../src/workflow.js";

describe("workflow domain", () => {
  it("accepts the canonical single-approval config", () => {
    const v = validateWorkflowConfig({
      trigger: "submission.created",
      steps: [{ type: "approval", key: "approval", assignee: "member" }],
    });
    expect(v.ok).toBe(true);
  });

  it("rejects branching configs", () => {
    expect(
      validateWorkflowConfig({
        trigger: "submission.created",
        steps: [
          { type: "approval", key: "a", assignee: "member" },
          { type: "approval", key: "b", assignee: "member" },
        ],
      }).ok,
    ).toBe(false);
    expect(validateWorkflowConfig({ trigger: "cron", steps: [] }).ok).toBe(false);
  });

  it("enforces task transition guards", () => {
    expect(canTransitionTask("pending", "claim")).toBe(true);
    expect(canTransitionTask("claimed", "claim")).toBe(false);
    expect(canTransitionTask("completed", "complete")).toBe(false);
    expect(canDecideTask("pending")).toBe(true);
    expect(canDecideTask("completed")).toBe(false);
  });

  it("maps outcomes to instance states", () => {
    expect(instanceStatusForOutcome("approved")).toBe("completed");
    expect(instanceStatusForOutcome("rejected")).toBe("rejected");
  });

  it("normalizes valid configs", () => {
    expect(
      normalizeWorkflowConfig({
        trigger: "submission.created",
        steps: [{ type: "approval", key: "approval", assignee: "unassigned" }],
      }),
    ).toEqual({
      trigger: "submission.created",
      steps: [{ type: "approval", key: "approval", assignee: "unassigned" }],
    });
  });
});
