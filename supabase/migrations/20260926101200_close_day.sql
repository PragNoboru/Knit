-- PRD 6.4, 9.1, D10: close day D (run at or after 00:00 IST of D+1). One transaction.
--
--   1. Task-days on D that are done or cancelled lock as they are. So do the completion
--      records of open-ended tasks, whatever their status: those tasks never spill (N4).
--   2. Yet to start and In progress become Not Done, carrying their status; Blocked stays
--      Blocked, carrying Blocked. All lock.
--   3. Each of those gets a spillover on next_working_day(D) with the carried status and
--      spill_index + 1 (on conflict do nothing). A blocked spillover keeps its reason (D2).
--   4. Any task-day, on any date, that became done or cancelled on D locks too: this freezes
--      early completions (6.5).
--
-- Idempotent: a second run finds everything locked and changes nothing. Refuses D >= today,
-- and refuses to close D while an earlier day still has unlocked task-days, because days close
-- in date order (6.4 step 3). Service role only. Returns counts, and the ids of the tasks it
-- touched so the close job can refresh their Knit Notes (10.5).
create function public.close_day(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today constant date := knit_today();
  v_next date;
  v_locked_as_is integer;
  v_not_done integer;
  v_blocked integer;
  v_spilled integer;
  v_early integer;
  v_locked_ids uuid[];
  v_closing_ids uuid[];
  v_early_ids uuid[];
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_day is null or p_day >= v_today then
    raise exception 'close_day_not_past'
      using detail = format('Only days before today (%s) can be closed.', v_today);
  end if;
  if exists (select 1 from task_days where day < p_day and not locked) then
    raise exception 'close_day_out_of_order'
      using detail = format('An earlier day still has open task-days; close it before %s.', p_day);
  end if;

  v_next := next_working_day(p_day);

  -- Step 1.
  with locked as (
    update task_days
    set locked = true, locked_at = now()
    where day = p_day
      and not locked
      and (status in ('done', 'cancelled') or origin = 'completion')
    returning task_id
  )
  select count(*), coalesce(array_agg(task_id), '{}')
  into v_locked_as_is, v_locked_ids
  from locked;

  -- Steps 2 and 3. In an UPDATE every SET expression reads the old row, so carried_status
  -- gets the status the task-day had before it closed.
  with closing as (
    update task_days
    set carried_status = status,
        status = case when status = 'blocked' then status else 'not_done' end,
        locked = true,
        locked_at = now()
    where day = p_day
      and not locked
      and status in ('yet_to_start', 'in_progress', 'blocked')
    returning task_id, carried_status, status, spill_index, reason
  ),
  spilled as (
    insert into task_days (task_id, day, status, spill_index, origin, reason)
    select task_id,
           v_next,
           carried_status,
           spill_index + 1,
           'spillover',
           case when carried_status = 'blocked' then reason end
    from closing
    on conflict (task_id, day) do nothing
    returning 1
  )
  select count(*) filter (where status = 'not_done'),
         count(*) filter (where status = 'blocked'),
         (select count(*) from spilled),
         coalesce(array_agg(task_id), '{}')
  into v_not_done, v_blocked, v_spilled, v_closing_ids
  from closing;

  -- Step 4.
  with early as (
    update task_days
    set locked = true, locked_at = now()
    where not locked
      and status in ('done', 'cancelled')
      and status_changed_on = p_day
    returning task_id
  )
  select count(*), coalesce(array_agg(task_id), '{}')
  into v_early, v_early_ids
  from early;

  return jsonb_build_object(
    'day', p_day,
    'next_working_day', v_next,
    'locked_as_is', v_locked_as_is,
    'not_done', v_not_done,
    'blocked', v_blocked,
    'spillovers', v_spilled,
    'early_completions_locked', v_early,
    -- Every task this call touched (spillovers belong to tasks already in the list).
    'task_ids', coalesce(
      (select jsonb_agg(distinct id order by id)
       from unnest(v_locked_ids || v_closing_ids || v_early_ids) as ids (id)),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.close_day(date) from public, anon, authenticated;
grant execute on function public.close_day(date) to service_role;
