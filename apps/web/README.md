# apps/web — Next.js App Router (arrives Phase 1)

Phase 0 establishes the contract this app will implement; no application code yet.

- Framework: Next.js App Router + React + TypeScript (strict, see tsconfig.base.json).
- Auth: Supabase Auth behind the `AuthProvider` interface (`@formos/auth`, Phase 1).
- Data: only via `@formos/database` typed queries (RLS-enforced); no raw SQL in routes.
- Validation: generated Zod from `@formos/forms-engine` (Phase 2+) at the BFF boundary.
- Browser code may import ONLY the public env subset (`publicEnv()` from `@formos/config`)
  and `@formos/ui` tokens — enforced by `scripts/guards`.
- Public renderer + embed budgets (RENDERER-EMBED.md) become CI gates in Phase 5.
