/**
 * Test-only vendor-out for `@rjsf/validator-ajv8` (SPIKES.md S1 fallback path).
 *
 * `@rjsf/core`'s barrel statically imports the AJV validator solely for its
 * `getTestRegistry` helper (never used by FORMOS). Production bundlers drop
 * that dead export (`sideEffects: false`), so AJV never ships — but the
 * vitest module graph must still resolve the specifier. This stub resolves it
 * to a poisoned proxy: any actual USE fails loudly, proving our code paths
 * never touch AJV.
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
