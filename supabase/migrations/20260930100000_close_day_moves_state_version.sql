-- PRD 8.1 (state_version: "bumped on every hub-side status change"), 9.1 (apply_pull_plan
-- refuses a plan computed on state that has since changed), 10.2 step 7, 10.5, invariant 8:
-- close_day moves the state_version of every tracker whose task-days it changed.
--
-- The close locks D's task-days, turns the open ones into Not Done and spills them (6.4). A
-- pull that loaded its state before that (the pull job, Sync now or an admin pull, which can
-- take the pull lease once the close's forced pull has released it) would otherwise apply its
-- plan afterwards: its update to D's task-day is dropped because that task-day is now locked,
-- while the task itself still takes the sheet's status, and the spillover the close created
-- keeps the old status for good. With the version moved, apply_pull_plan answers 'retry' and
-- the pull plans again against the closed day, where the spillover is the open task-day.
--
--   * Only trackers whose task-days this call changed move, and only when it changed
--     something: a second call on the same day changes nothing, the version included.
--   * The trackers are locked before any task-day, in the order apply_pull_plan takes its
--     locks (tracker first), so a close and a pull that overlap wait for each other instead of
--     deadlocking.
--
-- Everything else is as in 20260929110200_close_day_events_and_result.sql.
create or replace function public.close_day(p_day date)
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
  v_touched uuid[];
  v_notes integer := 0;
  v_stored jsonb;
  v_result jsonb;
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

  -- Tracker first, as apply_pull_plan locks them: every tracker with a task-day this call
  -- can change (steps 1 to 4 below).
  perform 1
  from trackers t
  where t.id in (
    select k.tracker_id
    from task_days d
    join tasks k on k.id = d.task_id
    where not d.locked
      and (d.day = p_day or (d.status in ('done', 'cancelled') and d.status_changed_on = p_day))
  )
  order by t.id
  for update of t;

  -- Step 1: done, cancelled and completion task-days on D lock as they are.
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
  -- gets the status the task-day had before it closed; RETURNING gives the new row. Each move
  -- to Not Done is an event (15).
  with closing as (
    update task_days
    set carried_status = status,
        status = case when status = 'blocked' then status else 'not_done' end,
        locked = true,
        locked_at = now()
    where day = p_day
      and not locked
      and status in ('yet_to_start', 'in_progress', 'blocked')
    returning id, task_id, carried_status, status, spill_index, reason
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
  ),
  logged as (
    insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                        old_value, new_value)
    select c.task_id, c.id, k.tracker_id, null, 'system', 'status',
           c.carried_status::text, c.status::text
    from closing c
    join tasks k on k.id = c.task_id
    where c.status = 'not_done'
    returning 1
  )
  select count(*) filter (where status = 'not_done'),
         count(*) filter (where status = 'blocked'),
         (select count(*) from spilled),
         coalesce(array_agg(task_id), '{}')
  into v_not_done, v_blocked, v_spilled, v_closing_ids
  from closing;

  -- Step 4: early completions and cancellations made on D freeze (6.5).
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

  -- Every task this call touched (spillovers belong to tasks already in the list), and N17:
  -- their Knit Notes are refreshed.
  select coalesce(array_agg(distinct id order by id), '{}')
  into v_touched
  from unnest(v_locked_ids || v_closing_ids || v_early_ids) as ids (id);
  if cardinality(v_touched) > 0 then
    v_notes := enqueue_note_refresh(v_touched);
    -- 8.1, 9.1: a pull plan computed before this close is recomputed after it.
    update trackers
    set state_version = state_version + 1
    where id in (select distinct k.tracker_id from tasks k where k.id = any (v_touched));
  end if;

  -- What closing D has done so far: an earlier call's result plus this call's changes.
  select close_result into v_stored from day_closures where day = p_day for update;
  v_result := jsonb_build_object(
    'day', p_day,
    'next_working_day', v_next,
    'locked_as_is', coalesce((v_stored ->> 'locked_as_is')::int, 0) + v_locked_as_is,
    'not_done', coalesce((v_stored ->> 'not_done')::int, 0) + v_not_done,
    'blocked', coalesce((v_stored ->> 'blocked')::int, 0) + v_blocked,
    'spillovers', coalesce((v_stored ->> 'spillovers')::int, 0) + v_spilled,
    'early_completions_locked',
      coalesce((v_stored ->> 'early_completions_locked')::int, 0) + v_early,
    'notes_queued', coalesce((v_stored ->> 'notes_queued')::int, 0) + v_notes,
    'task_ids', coalesce((
      select jsonb_agg(distinct t.id order by t.id)
      from (
        select jsonb_array_elements_text(coalesce(v_stored -> 'task_ids', '[]'::jsonb)) as id
        union
        select unnest(v_touched)::text
      ) t), '[]'::jsonb)
  );

  insert into day_closures (day, state, close_result)
  values (p_day, 'running', v_result)
  on conflict (day) do update set close_result = excluded.close_result;

  return v_result;
end;
$$;

revoke all on function public.close_day(date) from public, anon, authenticated;
grant execute on function public.close_day(date) to service_role;
