-- PRD N49, 6.10, 9.1, invariant 8: the RPCs that change a task's status take the tracker lock
-- first, as close_day, apply_pull_plan and admin_correct_task_day do.
--
-- set_task_status locked the task, then today's task-day, and touched the tracker last (its
-- state_version update). backlog_action locked the tasks and then updated their trackers.
-- admin_correct_task_day now locks the tracker before the task-day and the task (6.10, Q6),
-- like the jobs (N49). Two transactions taking the same locks in opposite orders can deadlock:
-- Postgres then aborts one of them (40P01) and the person sees only the generic error. With
-- every one of these taking the tracker first, a member's status change, an admin correction,
-- a backlog action, a close and a pull on the same tracker wait for each other instead.
--
--   * set_task_status reads the task's tracker without a lock and locks it before the task.
--     A task that does not exist locks nothing and is still refused with task_not_found.
--   * backlog_action locks the trackers of the given tasks, in id order, before the tasks.
--
-- Nothing else changes: set_task_status is as in 20260929110100_set_task_status_locks.sql and
-- backlog_action as in 20260928100000_admin.sql, with their grants.

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
  v_tracker_id uuid;
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

  -- N49, 6.10: find the tracker without locks and lock it before the task, the order
  -- close_day, apply_pull_plan and admin_correct_task_day take their locks in.
  select tracker_id into v_tracker_id from tasks where id = p_task_id;
  perform 1 from trackers where id = v_tracker_id for update;

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

create or replace function public.backlog_action(
  p_task_ids uuid[],
  p_action text,
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
  v_reason constant text := nullif(btrim(coalesce(p_reason, '')), '');
  v_task tasks%rowtype;
  v_status knit_status;
  v_config jsonb;
  v_changed integer := 0;
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_action not in ('bring_to_today', 'mark_done', 'cancel') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if p_action = 'cancel' and v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if char_length(v_reason) > 140 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  -- N49, 6.10: the trackers of these tasks first, in id order, then the tasks.
  perform 1
  from trackers t
  where t.id in (select k.tracker_id from tasks k where k.id = any (p_task_ids))
  order by t.id
  for update of t;

  for v_task in
    select * from tasks
    where id = any (p_task_ids) and history_only and removed_at_source is null
      and status not in ('done', 'cancelled')
    order by id
    for update
  loop
    if p_action = 'bring_to_today' then
      insert into task_days (task_id, day, status, spill_index, origin, reason)
      values (v_task.id, v_today, v_task.status, 1, 'backlog',
              case when v_task.status = 'blocked' then v_task.status_reason end)
      on conflict (task_id, day) do nothing;
      update tasks set history_only = false, updated_at = now() where id = v_task.id;
      insert into events (task_id, tracker_id, actor_user_id, origin, field, old_value, new_value)
      values (v_task.id, v_task.tracker_id, v_user, 'hub', 'backlog', 'history_only', 'brought_to_today');
    else
      v_status := case p_action when 'mark_done' then 'done' else 'cancelled' end;
      update tasks
      set status = v_status,
          status_reason = case when v_status = 'cancelled' then v_reason end,
          completed_on = case when v_status = 'done' then v_today end,
          hub_changed_at = now(),
          updated_at = now()
      where id = v_task.id;
      insert into events (task_id, tracker_id, actor_user_id, origin, field, old_value, new_value, reason)
      values (v_task.id, v_task.tracker_id, v_user, 'hub', 'status', v_task.status::text,
              v_status::text, case when v_status = 'cancelled' then v_reason end);
      update outbox set state = 'superseded' where task_id = v_task.id and state = 'pending';
      select config into v_config from trackers where id = v_task.tracker_id;
      -- N8: a JSON null write-back value leaves the status cell unchanged.
      insert into outbox (task_id, tracker_id, payload)
      values (v_task.id, v_task.tracker_id, jsonb_build_object(
        'status_value', v_config -> 'writeBack' -> (v_status::text),
        'completed_on', case when v_status = 'done' then v_today end));
    end if;
    -- 10.2 step 7: a pull plan computed before this change must be recomputed.
    update trackers set state_version = state_version + 1 where id = v_task.tracker_id;
    v_changed := v_changed + 1;
  end loop;
  return jsonb_build_object('changed', v_changed);
end;
$$;

revoke all on function public.backlog_action(uuid[], text, text)
  from public, anon;
grant execute on function public.backlog_action(uuid[], text, text)
  to authenticated;
