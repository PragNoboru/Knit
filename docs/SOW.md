# Knit: Statement of Work

| | |
| --- | --- |
| Project | Knit, a unified daily task hub over Google Sheet trackers |
| Owner and approver | Pragaman Kumar Anurag, Product & Growth Lead, Noboru World |
| Builder | Claude Code, working in Pragaman's repository |
| Date | 25 Sep 2026 |
| Governing spec | `docs/PRD.md` (what to build), `docs/TRACKERS.md` (the example trackers), `CLAUDE.md` (how to build) |

---

## 1. Purpose
Build and deploy Knit: a web app that pulls tasks from Google Sheet trackers placed in one Drive folder, shows each day's work in one list, syncs status both ways, locks each day at midnight IST, and carries unfinished work forward to the next working day until it is closed.

## 2. Background
Pragaman runs work across separate trackers: a Filing Buddy Google Ads tracker, a Filing Buddy Meta Ads tracker, a Noboru CA campaign tracker, a Sapiens content calendar, and, from 2 or 3 October 2026, an Auxman tracker. Each has different columns, date formats and status words. Tasks get missed because no single place shows what is due today. Knit fixes that without changing how the trackers are planned.

## 3. Objectives
1. Every task due today, from every tracker, visible on one screen with its source.
2. Status changes in either place reach the other: sheet to Knit within 10 minutes, Knit to sheet within 60 seconds.
3. Missed tasks lock as Not Done and spill forward on working days only, with history kept.
4. New trackers added by configuration in under 10 minutes.
5. Ready to extend to teammates with their own logins.

## 4. Scope

### 4.1 In scope, by phase
**Phase 0: Setup (Pragaman, with Claude Code guidance)**
- Accounts and projects under pragaman@noboruworld.com: GitHub repo, Supabase project (Mumbai region), Vercel project.
- Google Cloud project, Sheets API and Drive API enabled, one service account and key.
- The Knit folder in Google Drive, shared with the service account as Editor. Test copies of the trackers placed in it, each saved as a native Google Sheet.
- The Knit Archive sheet, outside the folder, shared with the service account.

**Phase 1: One tracker, full loop (Filing Buddy Google Ads test copy)**
- Database schema, RLS, RPC functions, calendar with holidays, seed data.
- Admin login and bootstrap.
- Domain library: date parser, working-day calendar, due-date policy, status mapping, owners, Knit Note, templates, pull planner. Full unit tests.
- SheetSource for Google and for xlsx fixtures.
- Jobs: discover, pull, push, close days, structure check; leases; cron registration.
- UI: Today, Day view, Calendar, All Tasks, task drawer, all empty states and banners.
- Admin: tracker wizard (all steps), Sync health, Needs Attention, Holidays, corrections, backlog review.
- Knit Archive append and nightly mismatch check.
- `docs/RUNBOOK.md`: how to deploy, rotate secrets, add a tracker, recover from each failure in PRD section 14.

**Phase 2: All of Pragaman's trackers**
- Connect Filing Buddy Meta Ads, Noboru CA Campaign and Sapiens test copies through the wizard, no code changes expected. Any code change needed here is a bug in Phase 1 and is fixed with a test.
- People aliases screen used for the non-user owners (Shlok, Anjan, Aryan, Creative, Sales, Agent).
- Connect Auxman when it arrives.
- Go-live: real trackers moved into the Knit folder, database reset, test copies archived.

**Phase 3: Teammates, their own tasks**
- User management screens, member role, member RLS verified, View as for admin, Report an issue.

**Phase 4: Shared trackers**
- Several users per tracker via the owner column; conflict rule reviewed with the owner and updated in the PRD before build.

**Phase 5: Optional, only if requested**
- Morning digest, spill-rate analytics per tracker, faster change detection, creating tasks from Knit.

### 4.2 Out of scope
- Editing task content or planned dates in Knit.
- Notifications of any kind (until Phase 5 is requested).
- Offline support, native mobile apps.
- Any change to tracker formulas, layouts or dropdowns other than adding the Knit ID and Knit Note columns.
- Integrations other than Google Sheets and Google Drive.
- Data migration of history from before each tracker's go-live date.

## 5. Deliverables
| # | Deliverable | Phase |
| --- | --- | --- |
| 1 | Git repository with the Next.js app, migrations, seed, scripts, tests | 1 |
| 2 | Production deployment on Vercel with Supabase, cron jobs registered | 1 |
| 3 | Test suite: unit, fixture, integration, race and E2E tests, passing in CI (GitHub Actions) | 1 |
| 4 | `docs/RUNBOOK.md` | 1 |
| 5 | Four trackers connected and running | 2 |
| 6 | Go-live on real trackers | 2 |
| 7 | Member access and admin View as | 3 |
| 8 | Shared-tracker support | 4 |

## 6. Roles and responsibilities
| Activity | Pragaman | Claude Code |
| --- | --- | --- |
| Create GitHub, Supabase, Vercel, Google Cloud accounts and projects | Does | Gives exact steps |
| Create service account and key, share Knit folder and Archive sheet | Does | Gives exact steps |
| Set environment variables and Vault secrets | Does | Lists exact names and values to fill |
| Write code, migrations, tests, docs | Reviews | Does |
| Run tests and CI | Reviews results | Does |
| Map trackers in the wizard | Does | Supports |
| Confirm open decisions (PRD section 21) | Decides | Asks before building anything that depends on them |
| Accept each phase | Signs off | Presents evidence against the acceptance criteria |

## 7. Setup checklist for Pragaman (Phase 0)
1. GitHub: create a private repository `knit` under the noboruworld account.
2. Supabase: new project `knit`, region Mumbai (`ap-south-1`). Note the URL, anon key and service-role key. In Authentication settings, disable sign-ups.
3. Supabase: enable the `pg_cron` and `pg_net` extensions (Database > Extensions).
4. Vercel: import the repository; do not deploy until the environment variables are set.
5. Google Cloud: create project `knit`; enable Google Sheets API and Google Drive API; create a service account `knit-sync`; create a JSON key and download it. If key creation is blocked by an organisation policy, ask the Google Workspace admin to allow service account keys for this project.
6. Google Drive: create the folder `Knit`; share it with the service account email as Editor. Copy the folder id from its URL.
7. Put test copies of the trackers in the folder. For each `.xlsx`, open it and use File > Save as Google Sheets; keep only the Google Sheet copy in the folder.
8. Create a Google Sheet `Knit Archive` outside the folder; share it with the service account as Editor; copy its id.
9. Generate a long random string for `KNIT_CRON_SECRET`.
10. Fill the environment variables in Vercel (PRD 18.1), deploy, then run the cron SQL (PRD 18.2) and the admin bootstrap script (PRD 18.4).

## 8. Phases, milestones and acceptance criteria

### Phase 1 milestones (engineering order, see `CLAUDE.md` for detail)
| Milestone | Content | Done when |
| --- | --- | --- |
| M0 | Scaffold, env validation, CI | CI green on an empty app with lint, typecheck, test |
| M1 | Schema, RLS, RPCs, seed, bootstrap admin | Integration tests for RLS, `set_task_status`, `close_day` pass locally |
| M2 | Domain library | All fixture date cases and calendar tests pass; planner tests cover PRD 6.6 and 10.3 |
| M3 | SheetSource | Fixture tests reproduce every `expected` block in `fixtures/trackers.config.json` |
| M4 | Pull + discover | Test tracker imported; re-running pull makes no changes |
| M5 | Status RPC, outbox, push | Status change appears in the sheet within 60 s; verify-after-write passes; race tests pass |
| M6 | Close days, leases, cron | Two consecutive closes produce identical results; a simulated 3-day outage catches up |
| M7 | User UI | Today, Day, Calendar, All Tasks, drawer, empty states, banners working on desktop and phone widths |
| M8 | Admin UI | Wizard connects a tracker end to end; Sync health, Needs Attention, Holidays, corrections, backlog review working |
| M9 | Archive, mismatch check, runbook, production deploy | Deployed; cron running; runbook complete |

### Phase acceptance criteria
| Phase | Accepted when |
| --- | --- |
| 1 | All M0 to M9 done; Pragaman uses Knit on the Filing Buddy Google Ads test copy for 10 consecutive working days with zero mismatches in the nightly check, and at least one real spillover chain (including a holiday or Sunday skip) is handled correctly |
| 2 | Filing Buddy Meta, Noboru CA and Sapiens connected with no code change beyond bug fixes with tests; Auxman connected in under 10 minutes; 2 weeks with no unresolved sync failures; go-live on real trackers completed |
| 3 | A teammate uses Knit daily for 2 weeks and never sees a task that is not theirs (verified by RLS tests and by Pragaman) |
| 4 | Two people work one tracker for 2 weeks with every conflict resolved according to the updated PRD rule |

## 9. Indicative timeline
Build time depends on review turnaround; durations are working days of effort.

| Phase | Build | Run and verify |
| --- | --- | --- |
| 0 | 1 day (Pragaman) | none |
| 1 | 6 to 8 days | 10 working days |
| 2 | 2 to 3 days (mostly configuration and fixes) | 2 weeks |
| 3 | 2 days | 2 weeks |
| 4 | 3 days | 2 weeks |

Auxman arrives on 2 or 3 October, during Phase 1. It is connected in Phase 2; nothing in Phase 1 waits for it.

## 10. Assumptions
1. All trackers are, or can be saved as, native Google Sheets in one Drive folder.
2. Each tracker tab has one header row and one task per row. Grid-style calendars (dates across columns) are not supported in v1; if Auxman arrives in that shape, a grid reader becomes a Phase 2 change request.
3. Adding two columns (Knit ID, hidden; Knit Note, visible) at the right of each tracker tab is acceptable.
4. Working days and holidays are as in PRD 6.2; 5th Saturdays are off unless changed (PRD Q1).
5. A single timezone, Asia/Kolkata, for everyone.
6. Up to about 10 trackers and 5,000 active tasks in the first year.

## 11. Risks and mitigations
| Risk | Impact | Mitigation |
| --- | --- | --- |
| Service account key creation blocked by a Google Workspace org policy | Phase 0 stalls | Admin allows keys for the `knit` project; decide early |
| Vercel Hobby plan terms are aimed at personal, non-commercial use | Compliance question for a company tool | Confirm the plan before Phase 3 when teammates join; Pro if required |
| Supabase free tier limits and pausing of inactive projects | Downtime | Jobs keep the project active; monitor usage on Sync health; upgrade if limits are approached |
| People rename headers, delete columns, paste over Knit IDs | Sync breaks | Pause-and-alert design, protected Knit ID column, structure check, runbook recovery steps |
| Text dates without years ("Mon 28 Sep") | Wrong dates | Weekday-validated year inference; invalid values flagged, never guessed |
| Formula-driven status columns (Noboru) | Overwriting formulas | Formula columns detected and never written |
| Google API quotas or outages | Delayed sync | Batching, change detection by modified time, backoff, outbox |
| Midnight job fails | Day not closed | Retries every 15 minutes, idempotent catch-up, morning banner |
| Scope creep during build | Delay | Change control (section 13) |

## 12. Acceptance and sign-off
At the end of each phase Claude Code presents: the checklist of acceptance criteria with evidence (test output, screenshots, sync health numbers), known issues, and the list of PRD sections implemented. Pragaman signs off in the repository by approving a pull request titled `Phase N acceptance`.

## 13. Change control
Any change to behaviour is first written into `docs/PRD.md` (decisions log or the relevant section) in its own commit, then implemented. Claude Code does not implement behaviour that is not in the PRD; it asks and proposes the PRD change instead.

## 14. Handover
- `docs/RUNBOOK.md`: deploy, environment variables, cron, rotating the service account key and cron secret, adding a tracker, go-live procedure, and step-by-step recovery for every failure in PRD section 14.
- `README.md`: local setup and test commands.
- All secrets held only by Pragaman; none committed.
