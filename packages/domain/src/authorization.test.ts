import { describe, expect, it } from "vitest";
import {
  can,
  canInvite,
  type Grant,
  type Principal,
} from "./authorization.js";

const member = (role: Principal["workspaceRole"], extra?: Partial<Principal>): Principal => ({
  userId: "u_1",
  workspaceRole: role,
  grants: [],
  assignments: [],
  ...extra,
});

describe("role rank enforcement", () => {
  it("viewer reads but never writes/exports/shares/manages", () => {
    const v = member("viewer");
    expect(can(v, "form", "read")).toBe(true);
    expect(can(v, "form", "update")).toBe(false);
    expect(can(v, "form", "share")).toBe(false);
    expect(can(v, "submission", "export")).toBe(false);
    expect(can(v, "member", "create")).toBe(false);
  });

  it("data collaborator edits submissions but not schema/billing", () => {
    const d = member("data_collaborator");
    expect(can(d, "submission", "update")).toBe(true);
    expect(can(d, "form", "update")).toBe(false);
    expect(can(d, "billing", "read")).toBe(false);
    expect(can(d, "integration", "create")).toBe(false);
  });

  it("builder builds but does not manage members/billing", () => {
    const b = member("builder");
    expect(can(b, "form", "create")).toBe(true);
    expect(can(b, "form", "delete")).toBe(true);
    expect(can(b, "member", "create")).toBe(false);
    expect(can(b, "billing", "read")).toBe(false);
  });

  it("admin manages but cannot delete workspace", () => {
    const a = member("admin");
    expect(can(a, "member", "create")).toBe(true);
    expect(can(a, "api_key", "create")).toBe(true);
    expect(can(a, "workspace_admin", "delete")).toBe(false);
  });

  it("owner holds delete-workspace", () => {
    expect(can(member("owner"), "workspace_admin", "delete")).toBe(true);
  });

  it("non-members are denied everything", () => {
    const anon = member(null);
    expect(can(anon, "form", "read")).toBe(false);
    expect(can(anon, "submission", "read", "s_1")).toBe(false);
  });
});

describe("deny-by-default", () => {
  it("unknown resource/action combinations deny", () => {
    const b = member("builder");
    // @ts-expect-error intentional unknown action probe
    expect(can(b, "form", "fly")).toBe(false);
  });
});

describe("assignment scope", () => {
  it("assignee reads/updates assigned submission below role floor", () => {
    const d = member("viewer", {
      assignments: [{ resourceType: "submission", resourceId: "s_9", assigneeUserId: "u_1" }],
    });
    expect(can(d, "submission", "read", "s_9")).toBe(true);
    expect(can(d, "submission", "update", "s_9")).toBe(true);
    expect(can(d, "submission", "read", "s_other")).toBe(false);
    expect(can(d, "submission", "delete", "s_9")).toBe(false);
  });
});

describe("resource grants", () => {
  const grant: Grant = {
    resourceType: "form",
    resourceId: "f_1",
    actions: ["read", "update"],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  it("grants scoped access to the exact resource", () => {
    const v = member("viewer", { grants: [grant] });
    expect(can(v, "form", "update", "f_1")).toBe(true);
    expect(can(v, "form", "update", "f_2")).toBe(false);
    expect(can(v, "form", "delete", "f_1")).toBe(false);
  });

  it("expired grants deny (above the role floor)", () => {
    const v = member("viewer", {
      grants: [{ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() }],
    });
    // update is above the viewer floor: only a live grant could allow it.
    expect(can(v, "form", "update", "f_1")).toBe(false);
  });
});

describe("invitations", () => {
  it("only owner/admin invite, never at-or-above own rank", () => {
    expect(canInvite("owner", "owner")).toBe(true);
    expect(canInvite("admin", "owner")).toBe(false);
    expect(canInvite("admin", "builder")).toBe(true);
    expect(canInvite("builder", "viewer")).toBe(false);
    expect(canInvite(null, "viewer")).toBe(false);
  });
});
