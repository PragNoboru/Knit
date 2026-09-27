-- PRD D7 (the Knit Note is kept current by Knit), 6.9, N17, N37: a task-day moved off a new
-- holiday gets its Knit Note refreshed.
--
-- A spillover's note reads "Spilled {n}x · now due {day}" (6.9). When a new holiday moves the
-- task-day to the next working day (N37), the sheet would keep naming the holiday as the due
-- day until some later write touched the task: the pull queues no write-back for it, and the
-- close of the holiday itself no longer has a task-day of that task.
--
-- So every task whose task-day the trigger moves gets a note-only write-back ({"note_only":
-- true}) in the same transaction, under the rules of enqueue_note_refresh (N17): the tracker
-- is active or paused, the task is not removed at source, and a task that already has a
-- write-back waiting gets none, since that push writes the current note. enqueue_note_refresh
-- itself only serves the jobs (knit_is_trusted), and this trigger runs for the admin who saves
-- the holiday, so the rows are inserted here.
--
-- Everything else is as in 20260930100200_holiday_moves_only_when_needed.sql.
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
      ),
      -- N17: the Knit Note names the new day (a data-modifying CTE always runs to the end).
      queued as (
        insert into outbox (task_id, tracker_id, payload)
        select k.id, k.tracker_id, '{"note_only": true}'::jsonb
        from moved m
        join tasks k on k.id = m.task_id
        join trackers t on t.id = k.tracker_id
        where k.removed_at_source is null
          and t.state in ('active', 'paused')
          and not exists (
            select 1 from outbox o where o.task_id = k.id and o.state in ('pending', 'held'))
        returning 1
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
