# Knit runbook

How to deploy Knit, run it day to day, rotate its secrets, add a tracker, go live, and recover from every failure in PRD section 14. The product rules are in `docs/PRD.md`; local setup and tests are in `README.md`.

Never paste a secret into this file, a commit, a chat or a screenshot. Secrets live only in Vercel's environment variables and Supabase Vault.

## 1. What runs where

| Part | Where | What it does |
| --- | --- | --- |
| App | Vercel (one project, production only) | Screens, server actions, job endpoints under `/api/jobs/*` |
| Database | Supabase (one project, Mumbai) | Tasks, task-days, rules as SQL functions, row level security, Auth |
| Jobs | Supabase `pg_cron` + `pg_net` | Calls the job endpoints on a schedule with the `x-knit-cron-secret` header |
| Trackers | Google Drive, the Knit folder | Google Sheets that Knit reads and writes through a service account |
| Archive | Google Sheet `Knit Archive`, outside the folder | Every closed day's task-days and events (PRD 10.7) |

Jobs (PRD 7.3; `pg_cron` runs in UTC):

| Job | Schedule | Endpoint | Work |
| --- | --- | --- | --- |
| `knit-pull` | every 10 min | `/api/jobs/pull` | Lists the Knit folder, pulls every active tracker whose sheet changed |
| `knit-push` | every minute | `/api/jobs/push` | Writes waiting status changes to the sheets and checks them |
| `knit-close` | every 15 min | `/api/jobs/close` | Closes every unclosed day before today (IST), oldest first |
| `knit-structure` | 01:00 UTC (06:30 IST) | `/api/jobs/structure` | Re-checks every tracker's headers and Knit columns; warns when the calendar ends within 60 days |

## 2. First production deploy

Do the steps in order. Each ends with a check. Placeholders look like `<this>`.

### 2.1 Google Cloud and Drive (SOW 7, steps 5 to 9)

1. In Google Cloud, create the project `knit`. Enable **Google Sheets API** and **Google Drive API**.
2. Create the service account `knit-sync`. Create a JSON key and download it. If key creation is blocked, ask the Google Workspace admin to allow service account keys for this project.
3. Turn the key file into one line of base64 (this is `GOOGLE_SERVICE_ACCOUNT_JSON`):
   - macOS or Linux: `base64 -w0 key.json` (macOS: `base64 -i key.json`)
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`

   Then delete the key file from Downloads.
4. In Drive, share the `Knit` folder with the service account's email as **Editor**. Copy the folder id from its URL (the part after `/folders/`): this is `KNIT_DRIVE_FOLDER_ID`.
5. Put each tracker in the folder as a native Google Sheet (for an `.xlsx`: File > Save as Google Sheets, and keep only the Google Sheet).
6. Create a Google Sheet `Knit Archive` outside the folder, share it with the service account as **Editor**, and copy its id from its URL (the part after `/d/`): this is `KNIT_ARCHIVE_SHEET_ID`.

Check: the service account's email appears under Share on both the folder and the archive sheet.

### 2.2 Supabase

1. In the Supabase project (region Mumbai): Authentication > Sign In / Providers: turn **off** "Allow new users to sign up" (D6: the admin creates every login), and keep the **Email** provider **on** (users sign in with email and password).
2. Authentication > URL Configuration: set Site URL to the production URL, for example `https://<app>.vercel.app`.
3. Database > Extensions: enable `pg_cron` and `pg_net`.
4. Apply the migrations from a terminal in the repository:

   ```bash
   pnpm exec supabase login
   pnpm exec supabase link --project-ref <project-ref>
   pnpm exec supabase db push
   ```

   `link` asks for the database password (Project Settings > Database). `db push` applies every file in `supabase/migrations` in order; it never deletes data.
5. Project Settings > API: copy the project URL, the anon (or publishable) key and the service role (or secret) key.

Check: Table Editor lists `tasks`, `task_days`, `trackers`; SQL editor `select count(*) from calendar_days;` returns 730 (2026 and 2027).

Do not connect Supabase's GitHub integration with automatic migrations: migrations are applied only with `db push`, on purpose.

### 2.3 Vercel

1. Project Settings > Environment Variables, for **Production** (PRD 18.1):

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon or publishable key |
   | `SUPABASE_SERVICE_ROLE_KEY` | service role or secret key (server only) |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | the base64 line from 2.1 step 3 |
   | `KNIT_DRIVE_FOLDER_ID` | from 2.1 step 4 |
   | `KNIT_ARCHIVE_SHEET_ID` | from 2.1 step 6 |
   | `KNIT_CRON_SECRET` | a new random string of at least 32 characters, for example the output of `openssl rand -hex 32` |
   | `APP_URL` | the production URL, `https://<app>.vercel.app` |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (Vercel then uses the pnpm version pinned in `package.json`) |

   Leave `KNIT_SHEET_SOURCE` unset: production always uses Google (N16 refuses `local` there).
2. Project Settings > Functions: set the region to **Mumbai (bom1)**, next to the database.
3. Build only `main`: Project Settings > Git > Ignored Build Step, choose "Custom" and enter

   ```bash
   [ "$VERCEL_GIT_COMMIT_REF" != "main" ]
   ```

   (it skips every branch except `main`). Then turn deployments on: `vercel.json` keeps them off until now with `"git": {"deploymentEnabled": false}`; delete that `git` entry and push to `main`.
4. Deploy `main` (the push above, or Deployments > Redeploy).

Check: `https://<app>.vercel.app/api/health` answers `{"ok":true,"db":true,...}`. If the deployment fails at start with "Knit cannot start: environment variables are missing or invalid", the message names each missing variable (never its value): fix it and redeploy.

Preview deployments stay off: they would share the production database (PRD 18.3).

### 2.4 Jobs (PRD 18.2)

1. Open `supabase/sql/cron.sql`. In the Supabase SQL editor, paste it and replace the two placeholders with the production URL and the same `KNIT_CRON_SECRET` as in Vercel. Run it once. Do not save the filled-in copy anywhere.
2. Check, a few minutes later:

   ```sql
   select jobname, schedule, active from cron.job order by jobname;
   select jobid, status, return_message, start_time
   from cron.job_run_details order by start_time desc limit 10;
   ```

   and in Knit, Admin > Sync health lists `pull` and `push` runs.

### 2.5 First admin (PRD 18.4)

From a terminal in the repository, with a `.env.local` holding the production `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`:

```bash
pnpm bootstrap:admin
```

It asks for the password at a hidden prompt. Delete that `.env.local` afterwards, or point it back to the local database.

Check: sign in at `https://<app>.vercel.app/login`.

### 2.6 Deploy checklist

- [ ] Google: APIs on, service account key made, folder and archive shared as Editor, key file deleted
- [ ] Supabase: sign-ups off, Site URL set, `pg_cron` and `pg_net` on, `db push` done, calendar has 730 days
- [ ] Vercel: nine variables set for Production, region Mumbai, only `main` builds, deployments turned on
- [ ] `/api/health` is ok
- [ ] `cron.sql` run with the real URL and secret; `cron.job_run_details` shows successes
- [ ] Admin bootstrapped and signed in
- [ ] First tracker connected (section 4) and Today shows its tasks
- [ ] A status changed in Knit reaches the sheet within 60 seconds; a status changed in the sheet reaches Knit within 10 minutes (or at once with Sync now)

## 3. Every day

- **Today** shows banners when something is wrong: yesterday not closed (after 08:00 IST), a tracker paused, and after 17:30 IST how many tasks are still open.
- **Admin > Needs Attention** lists what Knit could not decide on its own (PRD invariant 7). Work through it; each item says what happened and where.
- **Admin > Sync health**: the last 50 job runs, write-backs waiting or failed, the last 14 days' closes, and when the working-day calendar ends.

Knit never guesses: an unmapped status counts as Yet to Start (never Done), an unreadable date keeps the task's last good dates, and a tracker whose layout changed is paused until it is fixed.

## 4. Add a tracker (PRD 11)

1. Put the sheet in the Knit folder as a native Google Sheet.
2. Press **Sync now** (or wait up to 10 minutes). Admin > Trackers shows it under **New sheet found**.
3. **Set up**, then follow the steps: tab, header row, columns, statuses, owners and policies, name/colour/go-live, preview, **Activate**.
   - Formula columns are read-only (N6): the status Knit writes must go to a plain column (for Noboru, the Done column).
   - Every status word must be mapped before activation.
   - Go-live defaults to today: rows planned before it are history only.
4. Activation adds a hidden **Knit ID** column (protected with a warning) and a visible **Knit Note** column at the right of the tab, writes an ID on every row and pulls the tracker. Do not edit, sort into, or delete the Knit ID column.
5. **Backlog review** (shown when old rows are still open): Bring to today, Mark done, or Cancel with a reason. Rows left alone stay history only.

To change a live tracker's mapping later: Admin > Trackers > the tracker > **Edit mapping**. Saving checks the tab and pulls again; history is never rewritten.

## 5. Go-live on the real trackers (SOW Phase 2)

1. Agree the go-live date. The evening before, check Needs Attention is empty and Sync health shows yesterday closed.
2. Archive the test trackers: Admin > Trackers > each tracker > **Archive**.
3. Move the test copies out of the Knit folder; move the real trackers in (as native Google Sheets).
4. Reset the database for a clean start. This deletes every task, user and setting and applies the migrations again; the sheets are not touched and the Knit Archive keeps the test period's history:

   ```bash
   pnpm exec supabase db reset --linked
   ```

   Then run `cron.sql` again (2.4) and bootstrap the admin again (2.5).
5. Connect each real tracker (section 4) with go-live on the agreed date, and review each backlog.

## 6. Rotate secrets

| Secret | Steps |
| --- | --- |
| `KNIT_CRON_SECRET` | Make a new value. Update it in Vercel and redeploy. Then, in the SQL editor: `select vault.update_secret((select id from vault.secrets where name = 'knit_cron_secret'), '<new value>');`. Until both match, job calls are refused with 401 (nothing is lost: the jobs catch up). |
| Service account key | In Google Cloud, create a new key for `knit-sync`; base64 it (2.1 step 3); update `GOOGLE_SERVICE_ACCOUNT_JSON` in Vercel; redeploy; check Sync health shows a successful pull; then delete the old key in Google Cloud. |
| Supabase service role or secret key | Create or roll the key in Project Settings > API; update `SUPABASE_SERVICE_ROLE_KEY` in Vercel; redeploy; check `/api/health`; revoke the old key. |
| A user's password | Admin > People > Reset. Deactivate removes a user's access at once. |

## 7. Recover from failures (PRD 14)

| Failure | What you see | What to do |
| --- | --- | --- |
| A mapped header renamed or deleted | Banner "*Tracker* paused: column '*X*' not found." Needs Attention: Column missing. Tasks stay visible; write-backs wait. | Rename the header back in the sheet (or restore it from File > Version history), or change the mapping with Edit mapping. Then **Resume**. Waiting write-backs are sent. |
| Columns moved | Nothing | Nothing: headers are matched by name. |
| Rows sorted, inserted or moved | Nothing | Nothing: rows are found by Knit ID when writing. |
| A Knit ID duplicated by copy and paste | Needs Attention: Duplicate Knit ID | Nothing to fix: the lower row got a new ID and became a task. Check it is a real task (delete the row in the sheet if not), then Dismiss. |
| The Knit ID column deleted | Tracker paused: "the Knit ID column is missing" | Best: restore the column with File > Version history in the sheet, then Resume. Otherwise open the tracker in Admin > Trackers: **Recreate the Knit ID column** shows which rows match which tasks (by source ID, else title and planned date), which rows become new tasks and which tasks would count as removed. Check the lists, then **Recreate and resume**. |
| A tab renamed | Nothing | Nothing: tabs are kept by id. |
| A sheet moved out of the Knit folder | Tracker paused: "Left the Knit folder" | Move it back, then Resume. If it left on purpose, Archive the tracker. |
| A file that is not a Google Sheet | Admin > Trackers > Not Google Sheets | Open it and use File > Save as Google Sheets; remove the original from the folder. |
| An invalid date | Needs Attention: Date cannot be read, with the row | Fix the cell in the sheet (a real date, or text like "Mon 28 Sep"). New rows wait until it is readable; existing tasks keep their last good dates. Dismiss once fixed. |
| An unmapped status | Needs Attention: Unmapped status; its rows count as Yet to Start | **Map** it to a Knit status right there (or in Edit mapping). The tracker is pulled again. |
| An unknown owner | Needs Attention: Unknown owner (one item per name) | **Link** it to a user, or mark it Not a Knit user. The trackers are pulled again. |
| A write refused (protected range) | Needs Attention: Write refused; the task shows "Not saved to sheet" | Give the service account edit rights on the status and completed-on columns (Data > Protect sheets and ranges), then **Retry** (or Sync health > Retry failed). |
| A task's row deleted before its write | Needs Attention: Row not found | If the row was deleted on purpose, Dismiss: the next pull marks the task removed. If not, restore the row from Version history and Retry. |
| Formula column mapped for writing | Tracker paused, Needs Attention: Formula column | Edit mapping: choose a plain column for the status or completed-on write. |
| Google 429 or 5xx | Sync health shows failed runs with Google errors | Nothing: calls back off and retry; write-backs wait in the outbox. If it lasts hours, check the Google Cloud quotas page. |
| Two job runs overlap | Sync health shows a run "skipped" | Nothing: a lease lets one run at a time. |
| The close interrupted | Admin banner after 08:00 IST "Yesterday is not closed yet"; Sync health > Day closes shows failed with the error | The close retries every 15 minutes and catches up day by day in order. Fix what the error names (often a paused tracker or Google errors), then wait for the next run. |
| Supabase unavailable | "Knit can't load this page" with Try again | Check the Supabase status page and the project (a paused free project: Restore). Nothing is lost: the sheets and the Knit Archive hold the data. |
| Dates look a day off | Tasks on the wrong day | Knit uses India time everywhere. In the SQL editor `select knit_today();` must show today's date in India. If it does not, report it: do not change the server's timezone. |
| The calendar is about to end | Sync health warning, Needs Attention: Calendar ending | Admin > Holidays: add next year's holidays, then **Extend by a year**. |
| A member reports a wrong past day | Needs Attention: Report from a member | Open the task, and in its drawer use **Request correction** on that day, with a reason. |

## 8. Backups and history

- The Knit Archive sheet gets every closed day's task-days and events, so history survives even if the database is lost.
- The sheets themselves are the source of task content; their version history is the first place to look when something was changed by mistake.
- Supabase's own backups depend on the plan; check Database > Backups.

## 9. Where things are

| What | Where |
| --- | --- |
| Product rules and decisions | `docs/PRD.md` (section 5 is the decisions log) |
| Scope and milestones | `docs/SOW.md` |
| Example trackers | `docs/TRACKERS.md`, `fixtures/` |
| Database rules | `supabase/migrations/` (one concern per file, commented with PRD sections) |
| Cron registration | `supabase/sql/cron.sql` |
| Local setup and tests | `README.md` |
