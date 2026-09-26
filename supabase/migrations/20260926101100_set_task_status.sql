-- PRD 9.1, 6.1, 6.5, D2, D3: a user changes a task's status in Knit.
--
-- Rules, in order:
--   * caller: the admin, or an active user the task is assigned to;
--   * status: one of the five user statuses (not_done is set by close_day alone);
--   * reason: required for blocked and cancelled, one line, at most 140 characters (D2);
--     dropped for the other statuses;
--   * target task-day: today's, else the task's next future one (pulled forward, D3, 6.5);
--     a locked target is refused (invariant 4: corrections go through admin_correct_task_day);
--   * open-ended tasks (N4) have no task-day until they are completed: done or cancelled
--     creates a `completion` task-day on today (6.5); other statuses stay on the task, so an
--     open-ended task never spills;
--   * a task with an unlocked task-day on an earlier date is waiting for that day to close
--     (6.4), and a task removed at source has no row to write back to (6.6): both refused;
--   * setting the status it already has, with the same reason, changes nothing.
-- Then: the task and task-day are updated (status_changed_on = today, hub_changed_at = now()),
-- the tracker's state_version is bumped (10.2), an event is written (15), older pending
-- write-backs are superseded and a new one is queued (10.4). The Knit Note is rendered by the
-- push job (6.9). Returns {task, task_day}.
create function public.set_task_status(
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
