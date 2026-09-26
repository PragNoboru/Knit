-- PRD 9.2: row level security on every table. Signed-in users only read, and only what 9.2
-- allows. Every change goes through the RPC functions or the server's service role
-- (CLAUDE.md invariant 9). The anon role gets nothing: Knit has no public data.

-- Table privileges first, so row level security is the second line of defence, not the only
-- one. Later migrations that add tables repeat this for them.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
-- 9.2 "holidays: admin writes". The policies below limit these to the admin.
grant insert, update, delete on public.holidays to authenticated;

alter table public.app_users enable row level security;
alter table public.people_aliases enable row level security;
alter table public.holidays enable row level security;
alter table public.calendar_days enable row level security;
alter table public.settings enable row level security;
alter table public.drive_files enable row level security;
alter table public.trackers enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.task_days enable row level security;
alter table public.outbox enable row level security;
alter table public.events enable row level security;
alter table public.sync_runs enable row level security;
alter table public.day_closures enable row level security;
alter table public.attention_items enable row level security;
alter table public.job_leases enable row level security;

-- app_users: a user reads their own row; the admin reads all.
create policy app_users_select on public.app_users
  for select to authenticated
  using (id = (select auth.uid()) or (select public.knit_is_admin()));

-- tasks, task_days, events: the admin, or an active user the task is assigned to.
create policy tasks_select on public.tasks
  for select to authenticated
  using (
    (select public.knit_is_admin())
    or (
      (select public.knit_is_active_user())
      and exists (
        select 1 from public.task_assignees a
        where a.task_id = tasks.id and a.user_id = (select auth.uid())
      )
    )
  );

create policy task_days_select on public.task_days
  for select to authenticated
  using (
    (select public.knit_is_admin())
    or (
      (select public.knit_is_active_user())
      and exists (
        select 1 from public.task_assignees a
        where a.task_id = task_days.task_id and a.user_id = (select auth.uid())
      )
    )
  );

create policy events_select on public.events
  for select to authenticated
  using (
    (select public.knit_is_admin())
    or (
      (select public.knit_is_active_user())
      and exists (
        select 1 from public.task_assignees a
        where a.task_id = events.task_id and a.user_id = (select auth.uid())
      )
    )
  );

-- task_assignees: the admin, or an active user reading their own assignments.
create policy task_assignees_select on public.task_assignees
  for select to authenticated
  using (
    (select public.knit_is_admin())
    or ((select public.knit_is_active_user()) and user_id = (select auth.uid()))
  );

-- trackers: the admin reads everything. Members see only name and colour, through the
-- tracker_public view below.
create policy trackers_select on public.trackers
  for select to authenticated
  using ((select public.knit_is_admin()));

-- Admin-only tables.
create policy people_aliases_select on public.people_aliases
  for select to authenticated using ((select public.knit_is_admin()));
create policy settings_select on public.settings
  for select to authenticated using ((select public.knit_is_admin()));
create policy drive_files_select on public.drive_files
  for select to authenticated using ((select public.knit_is_admin()));
create policy outbox_select on public.outbox
  for select to authenticated using ((select public.knit_is_admin()));
create policy sync_runs_select on public.sync_runs
  for select to authenticated using ((select public.knit_is_admin()));
create policy day_closures_select on public.day_closures
  for select to authenticated using ((select public.knit_is_admin()));
create policy attention_items_select on public.attention_items
  for select to authenticated using ((select public.knit_is_admin()));
create policy job_leases_select on public.job_leases
  for select to authenticated using ((select public.knit_is_admin()));

-- holidays and calendar_days: every signed-in user reads; the admin edits holidays.
-- calendar_days changes only through refresh_calendar.
create policy holidays_select on public.holidays
  for select to authenticated using (true);
create policy holidays_insert on public.holidays
  for insert to authenticated with check ((select public.knit_is_admin()));
create policy holidays_update on public.holidays
  for update to authenticated
  using ((select public.knit_is_admin())) with check ((select public.knit_is_admin()));
create policy holidays_delete on public.holidays
  for delete to authenticated using ((select public.knit_is_admin()));
create policy calendar_days_select on public.calendar_days
  for select to authenticated using (true);

-- PRD 9.2: members see the name and colour of the trackers that hold at least one task
-- assigned to them. The view runs with its owner's rights, so the where clause is the only
-- access rule: keep it in step with tasks_select.
create view public.tracker_public as
select t.id, t.name, t.color
from public.trackers t
where (select public.knit_is_admin())
   or (
     (select public.knit_is_active_user())
     and exists (
       select 1
       from public.tasks k
       join public.task_assignees a on a.task_id = k.id
       where k.tracker_id = t.id and a.user_id = (select auth.uid())
     )
   );

-- A single-table view is updatable in Postgres, and updates would run with the owner's rights,
-- so members get select and nothing else.
revoke all on public.tracker_public from anon, authenticated;
grant select on public.tracker_public to authenticated;
