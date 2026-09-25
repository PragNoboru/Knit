# CLAUDE.md: building Knit

You are building **Knit**, a daily task hub that syncs with Google Sheet trackers. The owner is Pragaman (pragaman@noboruworld.com). He reviews your work at the end of each milestone.

## Read first, in this order
1. `docs/SOW.md`: scope, phases, milestones, acceptance criteria, what Pragaman sets up himself.
2. `docs/PRD.md`: the specification. It is the source of truth. Section 5 is the decisions log.
3. `docs/TRACKERS.md`: the four example trackers and their quirks.
4. `fixtures/`: example trackers (`trackers/*.xlsx`), their registry configs with expected test numbers (`trackers.config.json`), date parser cases (`date-parser.cases.json`), holidays (`holidays.json`).

Do not start coding until you have read all four. Then confirm back to Pragaman, in a few lines, the milestone you are starting and anything in PRD section 21 that blocks it.

## Invariants (never break these)
1. **IST only.** Every date decision uses Asia/Kolkata through `lib/time.ts` or `knit_today()`. Never `new Date()` date math in UTC for business dates. Tests run with `TZ=UTC`.
2. **Never write to a formula column.** Detect formula columns at setup and on every structure check; refuse to write to them.
3. **Never trust row numbers.** Identify rows only by the Knit ID column, re-read at the moment of writing.
4. **Never edit a locked task-day** except through `admin_correct_task_day`.
5. **Never change a tracker's planned date, title or content.** Knit writes only: the status cell, the completed-on cell, the Knit Note cell, the Knit ID cell.
6. **Never delete source data.** Knit never deletes rows, cells or columns in a sheet.
7. **When unsure, pause and tell.** Missing header, unmapped status, invalid date, unknown owner: raise a Needs Attention item and pause or skip. Never guess, never default to Done.
8. **Every job is idempotent and resumable.** Running any job twice gives the same result. Killing it mid-run loses nothing.
9. **Rules live in the database or in pure domain modules**, never in React components. Mutations go through RPC functions that enforce locks, reasons and permissions.
10. **Secrets stay on the server.** The service-role key and Google key are never importable from client code.
11. **No behaviour outside the PRD.** If something is missing or ambiguous, stop and propose a PRD change; do not invent.

## Stack
Next.js (current stable, App Router) + TypeScript strict + Tailwind + shadcn/ui; Supabase (Postgres, Auth, RLS, pg_cron, pg_net, Vault); Vercel; Google Sheets API v4 and Drive API v3 via a service account; zod; date-fns + date-fns-tz; Vitest; Playwright; SheetJS for reading fixtures in tests only. Package manager: pnpm.

## Commands (create these scripts)
- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`
- `pnpm test` (unit + fixture), `pnpm test:int` (needs local Supabase: `supabase start`), `pnpm test:e2e`
- `pnpm db:reset` (local migrations + seed), `pnpm bootstrap:admin`

CI (GitHub Actions) runs lint, typecheck, unit and fixture tests on every push, and integration tests with the Supabase CLI.

## Build order (Phase 1)
Work one milestone at a time. At the end of each: all tests green, a short summary to Pragaman of what was built, how it was tested, and anything that needs his decision. Wait for his go-ahead before the next milestone.

| Milestone | Build | Stop and show |
| --- | --- | --- |
| M0 | Scaffold, `lib/env.ts` (zod), lint, typecheck, Vitest, CI | CI green |
| M1 | Migrations for PRD 8.1, RLS (9.2), RPCs (9.1), `refresh_calendar`, seed (holidays from `fixtures/holidays.json`, calendar 2026 to 2027), `scripts/bootstrap-admin.ts` | Integration tests: RLS, `set_task_status` rules, `close_day` spill + idempotency + holiday skip |
| M2 | `lib/domain/*`: dates, calendar, due-date policy, status, owners, templates, Knit Note, `planPull` | Every case in `date-parser.cases.json`; October 2026 calendar checks; merge table; PRD 6.6 rows |
| M3 | `lib/sheets/*`: `SheetSource`, `XlsxFixtureSource`, `MemorySheetSource`, `GoogleSheetSource` | Fixture tests match every `expected` block in `trackers.config.json` |
| M4 | Discover + pull jobs, `apply_pull_plan`, structure check, leases, `sync_runs` | Pull twice: second run changes nothing. Race tests for ID writing |
| M5 | Outbox, push job, verify-after-write, immediate push from the server action | Status change lands in a real test sheet in under 60 s |
| M6 | Close-days job, Archive append, mismatch check, cron SQL | Simulated 3-day gap catches up in order; running close twice is a no-op |
| M7 | UI: Today, Day, Calendar, All Tasks, drawer, empty states, banners, mobile layout | Playwright flows green; screenshots at 1280 px and 390 px |
| M8 | Admin: wizard (all steps), Sync health, Needs Attention, People, Holidays, corrections, backlog review | Wizard connects the Filing Buddy Google Ads test sheet end to end |
| M9 | `docs/RUNBOOK.md`, `README.md`, production deploy checklist | Pragaman deploys with the runbook alone |

Phases 2 to 4 follow the SOW; each starts with a PRD review.

## Conventions
- TypeScript `strict`, no `any`; zod at every boundary (env, server action input, tracker config, Sheets responses).
- Domain functions are pure and take `today` as a parameter.
- SQL: one concern per migration, forward-only, with comments explaining each rule and the PRD section it implements.
- Server actions return typed results `{ ok: true, data } | { ok: false, error }`; the UI shows errors in plain language.
- Name things as the PRD names them: task, task-day, tracker, Knit ID, Knit Note, spillover, close.
- UI copy follows PRD 12.3 and 12.7 exactly. No em dashes in any UI copy or docs; use a colon, comma or middle dot.
- Log structured JSON on the server; never log sheet content, tokens or keys.
- Commit messages: `M<n>: <what>`; PRD changes in their own commits: `PRD: <what>`.

## When you are stuck
- A tracker behaves in a way the PRD does not cover: write a failing fixture test that shows it, then propose the PRD change to Pragaman.
- A Google API limit or behaviour differs from the PRD's assumptions: say so with the evidence and propose the smallest change.
- Never weaken an invariant to make a test pass.
