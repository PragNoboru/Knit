-- PRD 12.8 (Holidays: due dates are recomputed for unlocked task-days), 6.2, 6.4 step 2, D11:
-- a new holiday moves the open spillovers already sitting on it.
--
-- A spillover lands on next_working_day(D) when D closes (6.4), and a Bring to today task-day
-- on the day it was brought (6.11). Neither follows the planned date, so the forced pull that
-- recomputes due dates after a holiday is saved never moves them. Left on the new holiday, they
-- would show as open work on a day off, lock as Not Done there and spill again.
--
-- So when a day on or after today becomes a holiday, its unlocked spillover and backlog
-- task-days that are not done or cancelled move to the next working day in the same
-- transaction, each with a `system` event (the day it left and the day it went to, with the
-- holiday's name as reason). The trackers' state_version moves, so a pull plan computed
-- before is recomputed (10.2 step 7). A task that already has a task-day on that next working
-- day is not moved: Needs Attention bad_date (day_already_used) names the day. Planned
-- task-days follow their recomputed due date on the forced pull (6.3.3, 6.6), under the
-- tracker's off-day policy. Locked task-days never change (invariant 4).
--
-- The trigger function becomes security definer so it can move task-days for the admin who
-- edits the holiday list; a trigger function cannot be called any other way.
create or replace function public.holidays_refresh_calendar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_first date;
  v_last date;
  v_next date;
begin
  select min(day), max(day) into v_first, v_last from calendar_days;
  if v_first is null then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.day between v_first and v_last then
    perform refresh_calendar(old.day, old.day);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.day between v_first and v_last then
    perform refresh_calendar(new.day, new.day);

    if new.day >= knit_today() and not is_working_day(new.day) then
      v_next := next_working_day(new.day);

      with moved as (
        update task_days d
        set day = v_next
        where d.day = new.day
          and not d.locked
          and d.origin in ('spillover', 'backlog')
          and d.status in ('yet_to_start', 'in_progress', 'blocked')
          and not exists (
            select 1 from task_days x where x.task_id = d.task_id and x.day = v_next)
        returning d.id, d.task_id
      ),
      logged as (
        insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                            old_value, new_value, reason)
        select m.task_id, m.id, k.tracker_id, null, 'system', 'due_date',
               new.day::text, v_next::text, new.name
        from moved m
        join tasks k on k.id = m.task_id
        returning tracker_id
      )
      update trackers set state_version = state_version + 1
      where id in (select tracker_id from logged);

      insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
      select k.tracker_id, d.task_id, 'bad_date', 'bad_date:' || d.task_id,
             jsonb_build_object('reason', 'day_already_used', 'day', v_next)
      from task_days d
      join tasks k on k.id = d.task_id
      where d.day = new.day
        and not d.locked
        and d.origin in ('spillover', 'backlog')
        and d.status in ('yet_to_start', 'in_progress', 'blocked')
      on conflict (tracker_id, dedupe_key) where state = 'open' do nothing;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.holidays_refresh_calendar() from public, anon, authenticated;
