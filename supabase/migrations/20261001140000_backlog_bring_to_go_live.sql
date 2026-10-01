-- PRD N61, 6.11 (amends N42), invariant 8: Bring to today never puts a task-day before go-live.
--
-- Go-live defaults to the next working day (N42) and activation opens the backlog review at
-- once, so the admin can apply Bring to today while the tracker's go-live date is still ahead.
-- The task-day then landed on knit_today(), a day before go-live: knit_close_start() includes
-- that day (N31), so close_day locked it not_done and spilled it onto go-live with spill index
-- 2, a miss that never happened.
--
--   * While the tracker's go_live_date is after knit_today(), Bring to today creates the
--     task-day on the go-live date. From the go-live date on it uses knit_today(), as 6.11
--     says. Either way: spill_index 1, origin backlog, history_only cleared, the task's current
--     status (N19 c).
--
-- Nothing else changes: backlog_action is as in 20261001100610_status_rpcs_lock_tracker_first.sql,
-- with the tracker locks taken first (N49) and its grants.

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
  v_day date;
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
      -- N61: on the go-live date while it is still ahead, else on today (6.11).
      select greatest(t.go_live_date, v_today) into v_day
      from trackers t where t.id = v_task.tracker_id;
      insert into task_days (task_id, day, status, spill_index, origin, reason)
      values (v_task.id, v_day, v_task.status, 1, 'backlog',
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
