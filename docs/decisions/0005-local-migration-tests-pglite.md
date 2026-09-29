# 0005. Test migrations locally with PGlite, not Docker

- Status: accepted
- Date: 2026-09-28

## Context

SPEC M1's done-when is "`supabase db reset` works". That command needs Docker, which isn't installed on the dev machine. Migrations still need a local gate before `supabase db push`.

## Decision

- `tests/migration.test.ts` applies every migration in `supabase/migrations/` to an in-process Postgres ([PGlite](https://pglite.dev)) as part of `npm test`.
- It first recreates Supabase's `anon` / `authenticated` / `service_role` roles and their permissive default grants, so the test proves the migration's revokes actually win.
- It asserts: expected tables, RLS on everywhere, zero policies, no anon/authenticated privileges, service_role access, constraints, cascades, append-only `pipeline_events`, idempotency keys, and an index on every FK column.

## Consequences

- PGlite runs Postgres 18; the remote is 17. Fine for DDL of this kind; if a migration uses a version-specific feature, check it on the remote with `--dry-run` too.
- It doesn't exercise Supabase-only pieces (PostgREST, `pg_cron`, `pg_net`, `auth` schema). Those get `tests/integration/` against the linked project.
- If Docker is installed later, `supabase db reset` becomes an additional check, not a replacement.

## Note on M1

The initial migration was pushed to the remote before this test existed. It then passed this suite unchanged, so no corrective migration was needed.
