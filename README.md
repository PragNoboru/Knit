# Knit

A daily task hub over Google Sheet trackers. What it does and why: `docs/PRD.md`. Scope and milestones: `docs/SOW.md`. How it is built: `CLAUDE.md`.

## Local setup

Needs Node 22 and pnpm (`npm install -g pnpm`; the exact version is pinned in `package.json`). The local database is Supabase in Docker, so Docker Desktop is needed for the database commands.

```bash
pnpm install
pnpm exec supabase start      # local Supabase: applies migrations and seed
cp .env.example .env.local    # then fill in the values (`pnpm exec supabase status` shows the local ones)
pnpm bootstrap:admin          # creates the first admin (PRD 18.4); asks for a password
pnpm dev
```

## Commands

| Command                | Does                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`             | Run the app locally                                                            |
| `pnpm build`           | Production build                                                               |
| `pnpm lint`            | ESLint, Prettier check, and the no-em-dash check                               |
| `pnpm format`          | Format everything with Prettier                                                |
| `pnpm typecheck`       | Generate Next.js route types, then run `tsc`                                   |
| `pnpm test`            | Unit and fixture tests (Vitest, always in the UTC zone)                        |
| `pnpm test:int`        | Integration tests against local Supabase (start it first)                      |
| `pnpm test:int:pglite` | The same integration tests on in-process Postgres, for machines without Docker |
| `pnpm db:reset`        | Rebuild the local database from the migrations and seed                        |
| `pnpm bootstrap:admin` | Create the first admin (safe to run again)                                     |

## Database

Migrations live in `supabase/migrations`, one concern each, forward-only, each rule commented with the PRD section it implements. Every mutation goes through an RPC function (`set_task_status`, `close_day`, `admin_correct_task_day`, ...) that checks its caller; signed-in users can only read, and only what row level security allows (PRD 9).

## Deployment

Vercel deployments are switched off in `vercel.json` (`git.deploymentEnabled: false`) until the production deploy in M9. The full runbook arrives in M9 as `docs/RUNBOOK.md`.
