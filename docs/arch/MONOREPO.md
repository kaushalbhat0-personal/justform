# Monorepo — smallest viable structure

```text
apps/web/               # Next.js App Router: (marketing) + (app) + (public)/f + api/v1
packages/domain/        # entities, zod schemas, RBAC policy, pure logic (no DB/HTTP)
packages/forms-engine/  # canonical schema, field registry, derivations, rule/calc interpreter (client+server safe)
packages/renderer/      # <Renderer> read-only (preview + public page + embed islands)
packages/ui/            # design-system primitives + theme (no business logic)
packages/auth/          # session helpers, requireUser/requireRole, AuthProvider interface
packages/database/      # ONLY DB access: migrations, RLS policies + tests, typed queries, seed
packages/api/           # thin route adapters (auth/validation/throttle → domain+database)
packages/config/        # eslint/tsconfig/env validation (zod)
workers/                # scheduled-tick handlers: outbox-tick, notification-dispatcher, webhook-sender, av-callback, rollups, gc (service-role only, no persistent process)
docs/                   # recon/, arch/, adr/, api/
supabase/               # config.toml, migrations/, seed.sql (must `db push` cleanly to stock Postgres 16)
```

| Package | Lives here | MUST NOT live here |
|---|---|---|
| domain | zod schemas, types, `can()` policy, quota rules | any DB/HTTP/JSX import |
| forms-engine | canonical types, 12 MVP field defs (FIELDS.md), derivations (JSON Schema/uiSchema/Zod), conditions eval, migrators | DB queries, API keys, CSS |
| renderer | presentational runner, embed loader script | mutations, auth checks |
| ui | button/input/dialog/table primitives, tokens | form field semantics |
| auth | session, workspace-role helpers, provider interface | product queries |
| database | migrations, RLS policies, typed queries, RLS tests, seed | React, route logic |
| api | auth/validation/throttle adapters | SQL strings (delegate to database) |
| workers | queue consumers, retries, DLQ, cron, scheduled jobs | Next.js imports, RLS user context |

Anti-sprawl rules:
1. No new `packages/*` without 2+ consumers and an ADR entry.
2. No `packages/shared|common|utils` — code lives in its owning package.
3. `apps/web` is the only app until 50k MAU; no `apps/docs|admin|embed` yet.
4. Max depth 2 (`packages/x/src/*`). Cross-package imports only via `index.ts` barrel; `database` never imports `api`/`auth` product code.
5. Self-host path: `supabase/` migrations must apply to plain Postgres 16 in CI (no proprietary extensions in the tenancy/authz path).
