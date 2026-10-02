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

Check: put the three Google values in a `.env.local` (never committed) and run `pnpm check:google`. It signs in as the service account, lists the folder, reads every sheet's tabs and checks it can edit each sheet and the archive, and ends with "The Google setup is ready." or a line per problem. It writes nothing.

### 2.2 Supabase

1. In the Supabase project (region Mumbai): Authentication > Sign In / Providers: turn **off** "Allow new users to sign up" (D6: the admin creates every login), and keep the **Email** provider **on** (users sign in with email and password).
2. Authentication > URL Configuration: set Site URL to the production URL, for example `https://<app>.vercel.app`.
   - Sessions last 30 days (D5): Knit's sign-in cookies expire 30 days after the last visit. If the plan offers it, also set Authentication > Sessions > Inactivity timeout to 30 days (`720h`), so a session copied off a device ends too.
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

On a live Knit, migration `20261001120200_snapshot_records_unmapped_words.sql` needs the new code first: merge, wait for the Vercel deploy to finish, then run `pnpm exec supabase db push` (the code from before would undo it). Then check, in the SQL editor, that this returns 0:

```sql
select count(*) from tasks k join trackers t on t.id = k.tracker_id
where k.source_snapshot ? 'statusKey'
  and (k.source_snapshot -> 'status') is distinct from 'null'::jsonb
  and not (coalesce(t.config -> 'statusMap', '{}'::jsonb) ? (k.source_snapshot ->> 'statusKey'));
```

### 2.3 Vercel

`vercel.json` already runs the app in Mumbai (`bom1`, next to the database) and builds only `main` (other branches would share the production database, PRD 18.3).

1. Put the Supabase keys in `.env.local` (Project Settings > API Keys: the anon or publishable key as `NEXT_PUBLIC_SUPABASE_ANON_KEY`, the service role or secret key as `SUPABASE_SERVICE_ROLE_KEY`), next to the Google values from 2.1.
2. Run `pnpm vercel:env https://<app>.vercel.app` (the address can be fixed later, step 5). It makes `KNIT_CRON_SECRET` once and keeps it in `.env.local`, and puts all nine production variables (PRD 18.1, plus `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel uses the pnpm version pinned in `package.json`) on the clipboard and in `.knit-local/vercel.env`. It prints names only.
3. On vercel.com: Add New > Project > import the GitHub repository (install Vercel's GitHub app for that repository only). Framework: Next.js; leave the build settings as detected. Under Environment Variables, paste the block into the first Key field: Vercel splits it into nine variables. Leave `KNIT_SHEET_SOURCE` unset: production always uses Google (N16 refuses `local` there). Click Deploy.
4. When the deploy finishes, note the address Vercel gave the project (Settings > Domains).
5. If it differs from the one used in step 2, change `APP_URL` in Settings > Environment Variables and redeploy (Deployments > the latest > Redeploy).

- Function time limit (PRD 7.3): every job call works for 80% of its function's `maxDuration` and leaves the rest to the next call. Knit ships with `maxDuration = 60` seconds, which every plan allows. To give each call the plan's allowed maximum (for example 300 seconds with Fluid compute on, which new projects have by default), change the value in all six places together, then deploy and run `cron.sql` again (2.4):
  - `export const maxDuration = 60;` in `app/api/jobs/pull/route.ts`, `app/api/jobs/push/route.ts`, `app/api/jobs/close/route.ts`, `app/api/jobs/structure/route.ts` and `app/(app)/layout.tsx` (Sync now);
  - `timeout_milliseconds := 60000` in `supabase/sql/cron.sql` (the value in milliseconds).

  A value above the plan's limit makes the deploy fail: check Project Settings > Functions first.

Check: `https://<app>.vercel.app/api/health` answers `{"ok":true,"db":true,...}`. If the deployment fails at start with "Knit cannot start: environment variables are missing or invalid", the message names each missing variable (never its value): fix it and redeploy.

### 2.4 Jobs (PRD 18.2)

1. Open `supabase/sql/cron.sql`. In the Supabase SQL editor, paste it and replace the two placeholders with the production URL and the same `KNIT_CRON_SECRET` as in Vercel. Run it. Do not save the filled-in copy anywhere. The script is safe to run again: it updates the secrets, the function and the jobs, so running it again is also how the app URL or the cron secret is changed.
2. Check, a few minutes later, that the jobs exist and that the app accepts their calls:

   ```sql
   select jobname, schedule, active from cron.job order by jobname;
   select status_code, left(content, 200) as content, error_msg, created
   from net._http_response order by created desc limit 10;
   ```

   Every response should have `status_code` 200. A 401 means the Vault secret differs from `KNIT_CRON_SECRET` in Vercel; a missing response or an `error_msg` means the URL is wrong. (`cron.job_run_details` only says the request was queued: `pg_net` sends it afterwards, so it shows "succeeded" even when the app refused the call.)

After 2.5, Admin > Sync health lists the job runs: `discover` every 10 minutes, and, once a tracker is connected (section 4), `pull` for each tracker. `push` and `close` show only calls that had something to do (a write-back pushed, a day closed) or failed, and any call of any job that found another call still running shows as "skipped".

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
- [ ] Vercel: project imported with the nine variables from `pnpm vercel:env`, `APP_URL` matching the real address, `maxDuration` checked against the plan (2.3)
- [ ] `/api/health` is ok
- [ ] `cron.sql` run with the real URL and secret; `net._http_response` shows status 200
- [ ] Admin bootstrapped and signed in; Sync health lists `discover` runs
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
   - Go-live defaults to the next working day (N42): rows due before it, today's included, are history only (their Knit Note says Before Knit go-live), and open ones are listed in the backlog review. Pick another date at step 7 if needed. Knit takes any date; when go-live is an off day, Bring to today (step 5) puts tasks on the working day after it.
   - Standard setup (PRD 11.1): for a tab made from the Knit Standard Tracker v2 (row 1 holds its 15 headers in order, brand columns only after Notes) or v1 (its 14 headers), the header row step offers **Use the standard setup** and names the version. It fills the columns, statuses and write-back words and opens Owners and policies: link or mark each unknown owner name, then check name, colour, go-live, preview and activate. Every step can still be changed. If the Status column has a word outside Not started, In progress, Blocked, Done and Cancelled, it opens Map statuses instead: map that word first. No button means a header was renamed, moved, doubled or left off row 1, or Status or Done on holds formulas: fix the sheet, or set it up step by step.
   - End date (N64): map it at step 4 when the tab has one. Date is the first day and End date the last; a blank End date is a one-day task. A multi-day task shows under Ongoing until its last working day, when it is due. An End date before its Date, or one Knit cannot read, shows in Needs Attention as Date cannot be read, and the task keeps its last good dates.
4. Activation adds a hidden **Knit ID** column (protected with a warning) and a visible **Knit Note** column at the right of the tab, writes an ID on every row and pulls the tracker. Do not edit, sort into, or delete the Knit ID column.
5. **Backlog review**: when old rows are still open, activation opens it straight away. Bring to today, Mark done, or Cancel with a reason. Rows left alone stay history only.
   - Bring to today puts the task on the first working day on or after go-live or today, whichever is later (N61): never before go-live and never on an off day. While go-live is still ahead (with the default go-live, the next working day, it always is on activation day), that is the go-live day, or the working day after it when go-live is an off day. From the go-live day on it is today, or the next working day when today is an off day. When that day is not today, the review names it under Action. Either way the task counts in Knit as spilled once (Spilled 1x), and the days before it close with no miss for it.
   - If the working-day calendar does not reach that day, Bring to today is refused (The calendar does not cover this date yet.) and nothing changes; the review says so under Action. Extend it first: Admin > Holidays, **Extend by a year** (section 7).
   - Bring to today also refreshes the row's Knit Note in the sheet within a minute or so, or once the tracker is resumed if it is paused (N63): it stops saying Before Knit go-live and shows the task as spilled once and due on its day. A row that already has a write-back waiting gets its note from that one.
   - Known edge case, PRD Q8 (open): before go-live, leave the planned date of a brought row alone in the sheet. A new date there still moves the task: to that date when it is today or later, else to today. If that day is before go-live, it closes as not done.
   - Mark done and Cancel work the same on any day. You can come back later from the tracker page (**open rows before go-live**).

To change a live tracker's mapping later: Admin > Trackers > the tracker > **Edit mapping**. Saving checks the tab and pulls again; history is never rewritten. Choosing another status column takes you to the statuses step: Knit keeps using the old column until the new column's words are mapped there.

Mapping or unmapping End date on a live tracker moves open tasks to their new due dates on the next pull (to today as a spillover when that day has passed); closed days are not changed. A tracker set up with the standard setup reads all its standard columns (15 in v2, 14 in v1): renaming, deleting or doubling any of them pauses it until restored and resumed.

Owner and Maker (PRD N72, N73): step 4's **Who does the task** is the column whose people get the task on their Today (Maker in v2). The optional **Checking owner** is the column naming who checks it (Owner in v2): Knit shows it on the task as "Owner: ...", and a row whose Who does the task cell is blank goes to the people named there. The standard setup fills both. Owner names are looked up, and reported in Needs Attention when unknown, only on rows whose Maker is blank.

Giving a word another Knit status changes only new rows and rows that change to it after you save; tasks already showing the word keep their status. A word mapped for the first time applies to every row that shows it, except tasks changed in Knit meanwhile: those keep their status, with a conflict when the word now means another one.

To connect another tab of a spreadsheet that already has a tracker: **Set up another tab** on the Trackers list or on the tracker's page.

## 5. Go-live on the real trackers (SOW Phase 2)

1. Agree the go-live date. The evening before, check Needs Attention is empty and Sync health shows yesterday closed.
2. Archive the test trackers: Admin > Trackers > each tracker > **Archive**.
3. Move the test copies out of the Knit folder; move the real trackers in (as native Google Sheets). Phase 2 goes live on Mon 5 Oct 2026 (PRD N71): every brand's tracker is built fresh from the blank Knit Standard Tracker v2, with its schedule starting on 5 Oct, never as a copy of another live tracker (its hidden Knit IDs would come along). The format is in `docs/TRACKERS.md` section 7. Make the blank v2 template from v1 first, before anyone copies tasks into it, with the checklist there ("Make the blank v2 template from v1": insert Maker after Owner, its dropdown and header notes, the Guide tab, and a test that step 3 names v2). Keep the 15 headers in row 1 as they are (never rename, delete or double one), add brand columns only after Notes, keep the Status dropdown to its five words, and spell each person's name the same way in Owner and Maker.
4. Reset the database for a clean start. This deletes every task, user and setting and applies the migrations again; the sheets are not touched and the Knit Archive keeps the test period's history:

   ```bash
   pnpm exec supabase db reset --linked
   ```

   The reset keeps the Vault secrets but drops the jobs. Then run `cron.sql` again (2.4, it is safe to run again) and bootstrap the admin again (2.5).
5. Connect each real tracker (section 4): use **Use the standard setup** at step 3, and save the agreed go-live date at step 7 (connected the evening before, the default is that date). Review each backlog right after activation or later from the tracker page: while go-live is still ahead, Bring to today puts tasks on the go-live day (the working day after it if go-live is an off day), not on the day you use it, and refreshes their Knit Note in the sheet (N61, N63). Until go-live, leave the planned dates of brought rows alone in the sheet (section 4, step 5, PRD Q8).

## 6. Rotate secrets

| Secret | Steps |
| --- | --- |
| `KNIT_CRON_SECRET` | Make a new value. Update it in Vercel and redeploy. Then, in the SQL editor: `select vault.update_secret((select id from vault.secrets where name = 'knit_cron_secret'), '<new value>');` (or run `cron.sql` again with both values, 2.4). Until both match, job calls are refused with 401 (nothing is lost: the jobs catch up). |
| The app URL (`APP_URL`) | Update it in Vercel and redeploy, then run `cron.sql` again with the new URL (2.4). |
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
| A row deleted by mistake | The task disappears from Today | Put the row back (Undo or File > Version history). Before the next pull it stays the same task. After that it comes back as a new task with a new Knit ID, and the old task stays removed with its history (PRD N30). |
| The Knit ID column deleted | Tracker paused: "the Knit ID column is missing" | Best: restore the column with File > Version history in the sheet, then Resume. Otherwise open the tracker in Admin > Trackers: **Recreate the Knit ID column** shows which rows match which tasks (by source ID, else title and planned date), which rows become new tasks and which tasks would count as removed. Check the lists, then **Recreate and resume**. Restoring an older version of the whole sheet also brings back rows deleted since then; any already marked removed come back as new tasks. |
| The Knit Note column deleted or renamed | Tracker paused: "the Knit Note column is missing"; Needs Attention: Column missing. Write-backs wait. | Restore the column with File > Version history, or type **Knit Note** as the header of an empty column at the far right. Then **Resume**. Waiting write-backs are sent; the notes fill in again as tasks change and days close. |
| A Knit column copied (Knit ID or Knit Note twice) | Tracker paused: "column 'Knit Note' appears more than once" (or 'Knit ID') | Delete the copy in the sheet (keep the original, the first from the left), then **Resume**. |
| A tab renamed | Nothing | Nothing: tabs are kept by id. |
| A sheet moved out of the Knit folder | Tracker paused: "Left the Knit folder" | Move it back, then Resume. If it left on purpose, Archive the tracker. |
| A file that is not a Google Sheet | Admin > Trackers > Not Google Sheets | Open it and use File > Save as Google Sheets; remove the original from the folder. |
| An invalid date | Needs Attention: Date cannot be read, with the row | Fix the cell in the sheet (a real date, or text like "Mon 28 Sep"). New rows wait until it is readable; existing tasks keep their last good dates. Dismiss once fixed. |
| An unmapped status | Needs Attention: Unmapped status; its rows count as Yet to Start | **Map** it to a Knit status right there (or in Edit mapping). The tracker is pulled again. |
| An unknown owner | Needs Attention: Unknown owner (one item per name) | **Link** it to a user, or mark it Not a Knit user. The trackers are pulled again. |
| A write refused (protected range) | Needs Attention: Write refused; the task shows "Not saved to sheet" | Give the service account edit rights on the status and completed-on columns (Data > Protect sheets and ranges), then **Retry** (or Sync health > Retry failed). |
| A task's row deleted before its write | Needs Attention: Row not found | If the row was deleted on purpose, Dismiss: the next pull marks the task removed. If not, restore the row from Version history before the next pull (every 10 minutes, and sooner after Sync now or a day's close) and Retry. Once a pull has marked the task removed, the row comes back as a new task with a new Knit ID: make the change again on that task. |
| Formula column mapped for writing | Tracker paused, Needs Attention: Formula column | Edit mapping: choose a plain column for the status or completed-on write. |
| Google 429 or 5xx | Sync health shows failed `pull` runs with Google errors, and failed `push` runs with write-backs waiting for a retry | Nothing: calls back off and retry; write-backs wait in the outbox. If it lasts hours, check the Google Cloud quotas page. |
| Two job runs overlap | Sync health shows a run "skipped" | Nothing: a lease lets one run at a time. A change the admin saved while a pull was running (a mapping, a status, an owner name, a holiday) is still pulled: at once, or by the next pull within 10 minutes. |
| The close interrupted | Admin banner after 08:00 IST "Yesterday is not closed yet"; Sync health > Day closes shows failed with the error | The close retries every 15 minutes and catches up day by day in order. Fix what the error names (often a paused tracker or Google errors), then wait for the next run. |
| Supabase unavailable | "Knit can't load this page" with Try again | Check the Supabase status page and the project (a paused free project: Restore). Nothing is lost: the sheets and the Knit Archive hold the data. |
| Dates look a day off | Tasks on the wrong day | Knit uses India time everywhere. In the SQL editor `select knit_today();` must show today's date in India. If it does not, report it: do not change the server's timezone. |
| The calendar is about to end | Sync health warning, Needs Attention: Calendar ending | Admin > Holidays: add next year's holidays, then **Extend by a year**. |
| A member reports a wrong past day | Needs Attention: Report from a member | Open the task, and in its drawer use **Request correction** on that day, with a reason. |
| The sheet reopened a finished task | Needs Attention: Conflict "The sheet reopened a task Knit has closed" | Open the task, and in its drawer use **Request correction** on the day it ended (its last day, not counting days marked "Closed by correction"): pick the status the sheet shows, with a reason. Knit reopens it on today (the next working day on a day off), or on its own later day when it was planned or set for a later day, writes that status back and resolves the item. |

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
