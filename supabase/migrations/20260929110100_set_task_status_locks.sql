-- PRD 6.5, 6.4 step 2 (last bullet), N9, N10, N15, 9.1, invariant 4: two more locks that
-- set_task_status enforces itself, whatever the screens offer (7.2, invariant 9).
--
--   * An early completion or cancellation waits for the close of the day it was set on (6.4
--     step 2 freezes it; 6.5: "A status set today can be changed again until today closes").
--     Between midnight and that close, a task-day done or cancelled on an earlier day is
--     refused with day_not_closed, like the open task-day of N10. Otherwise the change would
--     move status_changed_on to today and the close would never freeze the completion.
--   * A finished open-ended task has its completion task-day on an earlier day, locked or
--     waiting for its close (N9). Changing its status again is refused with task_day_locked:
--     reopening it is an admin correction (N15). Setting the same status and reason again
--     still changes nothing (9.1).
--
-- Everything else is as in 20260926101100_set_task_status.sql.
create or replace function public.set_task_status(
  p_task_id uuid,
  p_status public.knit_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today constant date := knit_today();
  v_user constant uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_task tasks%rowtype;
  v_day task_days%rowtype;
  v_has_day boolean;
  v_created boolean := false;
  v_old_status knit_status;
  v_config jsonb;
  v_completed_on date;
begin
  if v_user is null or not (
    knit_is_admin()
    or exists (
      select 1
      from task_assignees a
      join app_users u on u.id = a.user_id
      where a.task_id = p_task_id and a.user_id = v_user and u.is_active
    )
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  if p_status is null or p_status = 'not_done' then
    raise exception 'status_not_selectable';
  end if;

  if p_status in ('blocked', 'cancelled') then
    if v_reason is null then
      raise exception 'reason_required';
    end if;
    if char_length(v_reason) > 140 then
      raise exception 'reason_too_long';
    end if;
  else
    v_reason := null;
  end if;

  select * into v_task from tasks where id = p_task_id for update;
  if not found then
    raise exception 'task_not_found';
  end if;
  if v_task.removed_at_source is not null then
    raise exception 'task_removed_at_source';
  end if;

  select * into v_day from task_days where task_id = p_task_id and day = v_today for update;
  v_has_day := found;
  if not v_has_day then
    select * into v_day
    from task_days
    where task_id = p_task_id and day > v_today
    order by day
    limit 1
    for update;
    v_has_day := found;
  end if;

  if v_has_day then
    if v_day.locked then
      raise exception 'task_day_locked';
    end if;
    if v_day.status = p_status and v_day.reason is not distinct from v_reason then
      return jsonb_build_object('task', to_jsonb(v_task), 'task_day', to_jsonb(v_day));
    end if;
    -- 6.4, 6.5: done or cancelled on an earlier day, not frozen yet: that day's close is due.
    if v_day.status in ('done', 'cancelled') and v_day.status_changed_on < v_today then
      raise exception 'day_not_closed';
    end if;
    v_old_status := v_day.status;
  else
    if exists (
      select 1 from task_days where task_id = p_task_id and day < v_today and not locked
    ) then
      raise exception 'day_not_closed';
    end if;
    if v_task.date_kind is distinct from 'open' then
      raise exception 'no_open_task_day';
    end if;
    if v_task.status = p_status and v_task.status_reason is not distinct from v_reason then
      return jsonb_build_object('task', to_jsonb(v_task), 'task_day', null);
    end if;
    -- N9, N15: a finished open-ended task's completion task-day is closed; reopening it is a
    -- correction.
    if v_task.status in ('done', 'cancelled') then
      raise exception 'task_day_locked';
    end if;
    v_old_status := v_task.status;
    if p_status in ('done', 'cancelled') then
      insert into task_days (task_id, day, status, spill_index, origin, reason, status_changed_on)
      values (p_task_id, v_today, p_status, 0, 'completion', v_reason, v_today)
      returning * into v_day;
      v_has_day := true;
      v_created := true;
    end if;
  end if;

  if v_has_day and not v_created then
    update task_days
    set status = p_status, reason = v_reason, status_changed_on = v_today
    where id = v_day.id
    returning * into v_day;
  end if;

  -- D13, 6.5: Completed On is today when the task is done (early or not); cleared otherwise.
  v_completed_on := case when p_status = 'done' then v_today end;

  update tasks
  set status = p_status,
      status_reason = v_reason,
      completed_on = v_completed_on,
      hub_changed_at = now(),
      updated_at = now()
  where id = p_task_id
  returning * into v_task;

  update trackers
  set state_version = state_version + 1
  where id = v_task.tracker_id
  returning config into v_config;

  insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                      old_value, new_value, reason)
  values (p_task_id, case when v_has_day then v_day.id end, v_task.tracker_id, v_user, 'hub',
          'status', v_old_status::text, p_status::text, v_reason);

  update outbox set state = 'superseded' where task_id = p_task_id and state = 'pending';

  -- N8: a JSON null write-back value means "leave the status cell unchanged".
  insert into outbox (task_id, tracker_id, payload)
  values (
    p_task_id,
    v_task.tracker_id,
    jsonb_build_object(
      'status_value', v_config -> 'writeBack' -> (p_status::text),
      'completed_on', v_completed_on
    )
  );

  return jsonb_build_object(
    'task', to_jsonb(v_task),
    'task_day', case when v_has_day then to_jsonb(v_day) end
  );
end;
$$;

revoke all on function public.set_task_status(uuid, public.knit_status, text)
  from public, anon;
grant execute on function public.set_task_status(uuid, public.knit_status, text)
  to authenticated;
