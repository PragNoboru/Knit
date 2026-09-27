-- PRD 12.8, 6.2, N37: a holiday is saved whenever nothing has to move off it.
--
-- The trigger looked up the next working day after a new holiday before it checked whether any
-- task-day had to move there. next_working_day raises calendar_not_covered when the calendar
-- has no working day after that date, so a holiday on the last working day of the calendar
-- (31 Dec 2027 today) could not be saved at all, even with nothing on it, and the admin was
-- told the calendar did not cover a date it covers.
--
-- The next working day is now looked up only when an open spillover or backlog task-day sits
-- on the new holiday. When one does and the calendar ends first, the save is still refused
-- with calendar_not_covered (invariant 7: Knit never guesses where the task-day goes); the
-- admin extends the calendar and saves again.
--
-- Everything else is as in 20260929110400_holiday_moves_task_days.sql.
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

    if new.day >= knit_today()
      and not is_working_day(new.day)
      and exists (
        select 1 from task_days d
        where d.day = new.day
          and not d.locked
          and d.origin in ('spillover', 'backlog')
          and d.status in ('yet_to_start', 'in_progress', 'blocked'))
    then
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
