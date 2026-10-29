import { describe, expect, it } from "vitest";
import { DomainError } from "@formos/domain";
import {
  buildSearchOr,
  clampLimit,
  decodeCursor,
  encodeCursor,
  keysetOr,
  likePattern,
  neighborOr,
  NIL_UUID,
} from "./query";

describe("cursor codec", () => {
  it("round-trips deterministically", () => {
    const t = "2026-10-22T10:00:00.000Z";
    const id = "11111111-1111-4111-8111-111111111111";
    const cursor = encodeCursor(t, id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ t, id });
  });

  it("rejects malformed cursors safely", () => {
    for (const bad of [
      "not-base64!!!",
      Buffer.from("hello").toString("base64url"),
      Buffer.from(JSON.stringify({ t: 1, id: 2 })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: "yesterday", id: "11111111-1111-4111-8111-111111111111" })).toString("base64url"),
      Buffer.from(JSON.stringify({ t: "2026-10-22T10:00:00.000Z", id: "nope" })).toString("base64url"),
      "",
    ]) {
      try {
        decodeCursor(bad);
        expect.unreachable(`cursor accepted: ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe("not_found");
      }
    }
  });
});

describe("search expression building", () => {
  it("escapes LIKE wildcards and strips or() syntax chars", () => {
    expect(likePattern("100%_x\\y")).toBe("*100\\%\\_x\\\\y*");
    expect(likePattern("a,b(c)d")).toBe("*abcd*");
    expect(likePattern("Bo Beta")).toBe("*Bo Beta*");
  });

  it("builds key-scoped ilike clauses plus exact UUID match", () => {
    expect(buildSearchOr("Bo", ["name", "email"])).toBe("payload->>name.ilike.*Bo*,payload->>email.ilike.*Bo*");
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(buildSearchOr(uuid, ["name"])).toBe(`id.eq.${uuid},payload->>name.ilike.*${uuid}*`);
    expect(buildSearchOr("x", [])).toBeNull();
  });

  it("builds keyset and neighbor predicates", () => {
    const t = "2026-10-22T10:00:00.000Z";
    const id = "11111111-1111-4111-8111-111111111111";
    expect(keysetOr(t, id)).toBe(`submitted_at.lt.${t},and(submitted_at.eq.${t},id.lt.${id})`);
    expect(neighborOr("older", t, id)).toBe(keysetOr(t, id));
    expect(neighborOr("newer", t, id)).toBe(`submitted_at.gt.${t},and(submitted_at.eq.${t},id.gt.${id})`);
  });

  it("clamps page sizes to the bounded range", () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit(25)).toBe(25);
    expect(NIL_UUID).toBe("00000000-0000-0000-0000-000000000000");
  });
});
