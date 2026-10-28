/**
 * Production vendor-out for `@rjsf/validator-ajv8` (SPIKES.md S1 fallback path).
 *
 * `@rjsf/core`'s barrel statically imports the AJV validator solely for its
 * `getTestRegistry` helper (never used by FORMOS). Vitest uses
 * `tests/stubs/validator-ajv8.ts` for the same purpose; bundlers
 * (webpack/Turbopack via `resolveAlias` in `apps/web/next.config.ts`) map the
 * specifier to THIS stub. If tree-shaking drops the dead `getTestRegistry`
 * branch the stub is never even included; if it is included, any actual USE
 * fails loudly, proving our code paths never touch AJV.
 *
 * This module must never be used — FORMOS validation authority is Zod.
 */
const poison = (): never => {
  throw new Error("@rjsf/validator-ajv8 must never be used — FORMOS validation authority is Zod");
};

const proxy: unknown = new Proxy(
  {},
  {
    get: poison,
    apply: poison,
    construct: poison,
  },
);

export default proxy;
