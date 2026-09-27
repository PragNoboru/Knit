-- PRD 6.4, 9.1, 10.5 steps 2 and 3, 15, 19, N17, invariant 8: close_day records what it
-- changes and keeps its result.
--
--   * 15 (every status change has an events row with actor and origin): each task-day the
--     close turns from Yet to Start or In Progress into Not Done gets an event with origin
--     `system` and no actor (8.1), old value the carried status, new value not_done. Blocked
--     stays Blocked, which is no change. Locking and spillovers change no status.
--   * N17: the Knit Note refreshes for the tasks it touched are queued in the same
--     transaction, so a job killed after the close can no longer lose them.
--   * 19, invariant 8: the result is kept in day_closures.close_result. A second call on the
--     same day changes nothing and returns that result, not zeros, so a close retried after a
--     later step failed (Knit Archive, mismatch check) still records D's real counts. When a
--     later call does change something, its counts are added.
--
-- Everything else is as in 20260926101200_close_day.sql.

alter table public.day_closures add column close_result jsonb;

comment on column public.day_closures.close_result is
  'What close_day(day) did (PRD 6.4, 19): counts, the tasks it touched and the Knit Note refreshes it queued. A later call returns it.';

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
