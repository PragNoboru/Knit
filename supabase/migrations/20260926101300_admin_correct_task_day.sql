-- PRD 6.10, 9.1, invariant 4: the admin corrects a locked task-day. One audited transaction.
--
--   * Admin only; the task-day must be locked (open ones change through set_task_status).
--   * New status: one of the five user statuses. A reason is always required (one line, at
--     most 140 characters, as D2).
--   * The change is an event with origin `correction`, old and new values and the reason.
--   * Correcting to done or cancelled closes the chain: every later task-day of the task,
--     locked ones included, becomes cancelled with the reason "Closed by correction on
--     {date}" (the day the correction is made, as "Mon 5 Oct"), each with its own event. The
--     task takes the new status; Completed On is the corrected day when done. A write-back is
--     queued.
--   * Correcting to yet to start, in progress or blocked only rewrites history, unless the
--     task is open-ended (N4), which simply reopens with that status. It is refused when the
--     task has no open task-day left, because the task would then vanish from every list
--     (goal 3); how such a task should reopen is an open question for the PRD.
create function public.admin_correct_task_day(
  p_task_day_id bigint,
  p_status public.knit_status,
  p_reason text
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
  v_day task_days%rowtype;
  v_task tasks%rowtype;
  v_chain_reason text;
  v_config jsonb;
  v_completed_on date;
  v_task_changed boolean := false;
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_status is null or p_status = 'not_done' then
    raise exception 'status_not_selectable';
  end if;
  if v_reason is null then
    raise exception 'reason_required';
  end if;
  if char_length(v_reason) > 140 then
    raise exception 'reason_too_long';
  end if;

  select * into v_day from task_days where id = p_task_day_id for update;
  if not found then
    raise exception 'task_day_not_found';
  end if;
  if not v_day.locked then
    raise exception 'task_day_not_locked';
  end if;
  select * into v_task from tasks where id = v_day.task_id for update;

  if p_status not in ('done', 'cancelled')
     and v_task.date_kind is distinct from 'open'
     and not exists (select 1 from task_days where task_id = v_task.id and not locked) then
    raise exception 'correction_would_orphan_task';
  end if;

  update task_days
  set status = p_status,
      reason = case when p_status in ('blocked', 'cancelled') then v_reason end,
      status_changed_on = v_today
  where id = v_day.id;

  insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                      old_value, new_value, reason)
  values (v_task.id, v_day.id, v_task.tracker_id, v_user, 'correction', 'status',
          v_day.status::text, p_status::text, v_reason);

  if p_status in ('done', 'cancelled') then
    v_chain_reason := 'Closed by correction on ' || knit_format_day(v_today);

    with changed as (
      update task_days d
      set status = 'cancelled', reason = v_chain_reason, status_changed_on = v_today
      from (
        select id, status from task_days where task_id = v_task.id and day > v_day.day
      ) old
      where d.id = old.id
        and (d.status, d.reason) is distinct from ('cancelled'::knit_status, v_chain_reason)
      returning d.id, old.status as old_status
    )
    insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                        old_value, new_value, reason)
    select v_task.id, changed.id, v_task.tracker_id, v_user, 'correction', 'status',
           changed.old_status::text, 'cancelled', v_chain_reason
    from changed;

    v_completed_on := case when p_status = 'done' then v_day.day end;
    update tasks
    set status = p_status,
        status_reason = case when p_status = 'cancelled' then v_reason end,
        completed_on = v_completed_on,
        hub_changed_at = now(),
        updated_at = now()
    where id = v_task.id;
    v_task_changed := true;
  elsif v_task.date_kind = 'open' then
    update tasks
    set status = p_status,
        status_reason = case when p_status = 'blocked' then v_reason end,
        completed_on = null,
        hub_changed_at = now(),
        updated_at = now()
    where id = v_task.id;
    v_task_changed := true;
  end if;

  if v_task_changed then
    update trackers
    set state_version = state_version + 1
    where id = v_task.tracker_id
    returning config into v_config;

    update outbox set state = 'superseded' where task_id = v_task.id and state = 'pending';

    insert into outbox (task_id, tracker_id, payload)
    values (
      v_task.id,
      v_task.tracker_id,
      jsonb_build_object(
        'status_value', v_config -> 'writeBack' -> (p_status::text),
        'completed_on', v_completed_on
      )
    );
  end if;

  return jsonb_build_object(
    'task', (select to_jsonb(t) from tasks t where t.id = v_task.id),
    'task_day', (select to_jsonb(d) from task_days d where d.id = v_day.id)
  );
end;
$$;

revoke all on function public.admin_correct_task_day(bigint, public.knit_status, text)
  from public, anon;
grant execute on function public.admin_correct_task_day(bigint, public.knit_status, text)
  to authenticated;
