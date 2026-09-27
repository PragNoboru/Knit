-- PRD 10.5 step 1, 6.4 steps 2 to 4, N12: the first day the close-days job considers.
--
-- 10.5 counts from the earliest go-live date of any tracker that is not a draft. A task-day
-- can still sit on an earlier day, because two paths create one on today whatever the go-live:
-- Bring to today in the backlog review (6.11) and the completion task-day of an open-ended
-- task (N9, 6.5). With a go-live set in the future, today is before it. close_day refuses
-- every later day while an earlier task-day is open (N12: close_day_out_of_order), so a day
-- the job never visits would stop every close for good. An early completion or cancellation
-- (6.5) also waits for the close of the day it was set on (6.4 step 2, last bullet), and
-- set_task_status refuses to change it until then.
--
-- So the job starts at the earliest of: that go-live date, the earliest open task-day, and
-- the earliest day an open task-day was completed or cancelled on. Days before the first
-- go-live usually have nothing to close; closing them is what 6.4 step 3 does for off days.
create or replace function public.knit_close_start()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select least(
    (select min(go_live_date) from trackers where state <> 'draft'),
    (select min(day) from task_days where not locked),
    (select min(status_changed_on) from task_days
     where not locked and status in ('done', 'cancelled'))
  )
$$;

-- The oldest day before today (IST) that has not been closed, from knit_close_start(). Null
-- when there is nothing to close.
create or replace function public.next_day_to_close()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select min(g.d)::date
  from generate_series(
         knit_close_start()::timestamp,
         (knit_today() - 1)::timestamp,
         interval '1 day') as g (d)
  where not exists (select 1 from day_closures c where c.day = g.d::date and c.state = 'closed')
$$;

revoke all on function public.knit_close_start() from public, anon, authenticated;
grant execute on function public.knit_close_start() to service_role;
revoke all on function public.next_day_to_close() from public, anon, authenticated;
grant execute on function public.next_day_to_close() to service_role;
