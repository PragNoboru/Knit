-- PRD N49, 6.10, N37, N53, invariant 8: the holiday trigger locks the trackers first.
--
-- When a new holiday moves open spillover and backlog task-days (N37), the trigger updated the
-- task-days, inserted events and note-only write-backs (which take FOR KEY SHARE on the task
-- and the tracker they reference), and moved the trackers' state_version last. Every RPC that
-- changes a tracker's task-days takes the tracker lock first (close_day, apply_pull_plan,
-- set_task_status, backlog_action, admin_correct_task_day: N49) and push_result does too
-- (20261001140200). A holiday saved while one of them ran on the same tracker could take the
-- same locks in the opposite order, and Postgres then aborts one of them (40P01).
--
--   * Before it moves anything, the trigger locks the trackers of the task-days it will move,
--     in id order (FOR UPDATE, as the N49 RPCs do), then moves the task-days as before.
--
-- Nothing else changes: holidays_refresh_calendar is as in
-- 20260930100300_holiday_move_refreshes_knit_note.sql, with its grants.

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

      -- N49: the trackers of the task-days it moves first, in id order, then the task-days.
      perform 1
      from trackers t
      where t.id in (
        select k.tracker_id
        from task_days d
        join tasks k on k.id = d.task_id
        where d.day = new.day
          and not d.locked
          and d.origin in ('spillover', 'backlog')
          and d.status in ('yet_to_start', 'in_progress', 'blocked'))
      order by t.id
      for update of t;

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
