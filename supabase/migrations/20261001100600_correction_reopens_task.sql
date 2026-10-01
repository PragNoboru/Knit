-- PRD 6.10, N15, Q6 (resolved 1 Oct 2026), 9.1, 10.3, invariants 4 and 7: an admin
-- correction to Yet to Start, In Progress or Blocked on the day a finished dated task ended
-- reopens the task, like a spillover of that day. Every other refusal stays.
--
--   * The day a finished (done or cancelled) dated task ended is its last task-day, not
--     counting task-days a correction cancelled ("Closed by correction on {date}"). A task-day
--     counts as cancelled by a correction only when it is cancelled and a correction event set
--     it to cancelled with that same reason, so a member's own Cancelled reason with the same
--     words never hides the day the task ended.
--   * A reopen needs that day to be the corrected one, the task to be finished and dated, and
--     no unlocked task-day with a non-final status. The corrected day must not itself be one a
--     correction cancelled.
--   * Any other non-final correction that would leave a dated task with no open task-day is
--     still refused (correction_would_orphan_task, N15).
--   * Where the task reopens (6.10): when its last task-day (by day, any status) is on today or
--     later (an early completion frozen by its close, 6.5, or a task-day a correction
--     cancelled), that task-day reopens in place: unlocked, with the new status, its day and
--     origin kept. Otherwise a task-day is added on today when today is a working day, else on
--     next_working_day(today), origin spillover. No task-day of the task is on or after today
--     then, so the insert cannot collide with (task_id, day). A closed day never gets an open
--     task-day.
--   * Spill index (N38): an added task-day, or a task-day a correction cancelled that reopens
--     in place, gets the corrected task-day's spill index plus one, because days a correction
--     cancelled are not moves. The corrected task-day reopening in place keeps its own.
--   * Each task-day the reopen changes or adds gets its own correction event with the admin's
--     reason. Other task-days a correction cancelled stay cancelled.
--   * The task takes the new status (reason only for Blocked) and Completed On is cleared.
--     state_version moves, older pending write-backs are superseded (note-only ones included,
--     N17) and a write-back is queued: the status word from writeBack (N8; null leaves the
--     cell alone) and completed_on null, which the push clears under N24. The Knit Note is
--     rendered at push (6.9).
--   * An open conflict item raised because the sheet reopened the task (10.3,
--     reopened_in_source) is resolved in the same transaction: its text is no longer true and
--     it would hold the task's conflict dedupe key.
--   * A reopen is refused for a task removed at source (task_removed_at_source, N11) and when
--     the calendar does not cover the day (calendar_not_covered, from is_working_day and
--     next_working_day).
--   * Lock order (N49): the tracker first, then the corrected task-day and the task, then the
--     task's last task-day, as close_day and apply_pull_plan lock trackers first.
--
-- Everything else is as in 20260926101300_admin_correct_task_day.sql.
create or replace function public.admin_correct_task_day(
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
  v_task_id uuid;
  v_tracker_id uuid;
  v_day task_days%rowtype;
  v_task tasks%rowtype;
  v_last task_days%rowtype;
  v_target date;
  v_new_day_id bigint;
  v_chain_reason text;
  v_config jsonb;
  v_completed_on date;
  v_task_changed boolean := false;
  v_reopen boolean := false;
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

  -- N49: find the tracker without locks, lock it, then the task-day and the task.
  select task_id into v_task_id from task_days where id = p_task_day_id;
  if not found then
    raise exception 'task_day_not_found';
  end if;
  select tracker_id into v_tracker_id from tasks where id = v_task_id;
  perform 1 from trackers where id = v_tracker_id for update;

  select * into v_day from task_days where id = p_task_day_id for update;
  if not found then
    raise exception 'task_day_not_found';
  end if;
  if not v_day.locked then
    raise exception 'task_day_not_locked';
  end if;
  select * into v_task from tasks where id = v_day.task_id for update;

  -- Q6: is this the day a finished dated task ended?
  v_reopen :=
    p_status not in ('done', 'cancelled')
    and v_task.date_kind is distinct from 'open'
    and v_task.status in ('done', 'cancelled')
    -- The corrected task-day is not one a correction cancelled.
    and not (
      v_day.status = 'cancelled'
      and exists (
        select 1 from events e
        where e.task_id = v_task.id
          and e.task_day_id = v_day.id
          and e.origin = 'correction'
          and e.new_value = 'cancelled'
          and e.reason = v_day.reason
          and e.reason like 'Closed by correction on %'))
    -- Every later task-day is one a correction cancelled.
    and not exists (
      select 1 from task_days d
      where d.task_id = v_task.id
        and d.day > v_day.day
        and not (
          d.status = 'cancelled'
          and exists (
            select 1 from events e
            where e.task_id = v_task.id
              and e.task_day_id = d.id
              and e.origin = 'correction'
              and e.new_value = 'cancelled'
              and e.reason = d.reason
              and e.reason like 'Closed by correction on %')))
    -- The task has no open task-day.
    and not exists (
      select 1 from task_days d
      where d.task_id = v_task.id
        and not d.locked
        and d.status in ('yet_to_start', 'in_progress', 'blocked'));

  if v_reopen and v_task.removed_at_source is not null then
    raise exception 'task_removed_at_source';
  end if;

  if p_status not in ('done', 'cancelled')
     and v_task.date_kind is distinct from 'open'
     and not exists (select 1 from task_days where task_id = v_task.id and not locked)
     and not v_reopen then
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
  elsif v_reopen then
    -- Q6, 6.10: reopen like a spillover of the corrected task-day.
    select * into v_last from task_days
    where task_id = v_task.id
    order by day desc
    limit 1
    for update;

    if v_last.day >= v_today then
      -- In place: a frozen early completion (the corrected day itself) or a task-day a
      -- correction cancelled.
      update task_days
      set status = p_status,
          reason = case when p_status = 'blocked' then v_reason end,
          status_changed_on = v_today,
          locked = false,
          locked_at = null,
          spill_index = case when v_last.id = v_day.id then spill_index
                             else v_day.spill_index + 1 end
      where id = v_last.id;

      if v_last.id <> v_day.id then
        insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                            old_value, new_value, reason)
        values (v_task.id, v_last.id, v_task.tracker_id, v_user, 'correction', 'status',
                v_last.status::text, p_status::text, v_reason);
      end if;
    else
      v_target := case when is_working_day(v_today) then v_today
                       else next_working_day(v_today) end;

      insert into task_days (task_id, day, status, spill_index, origin, reason,
                             status_changed_on)
      values (v_task.id, v_target, p_status, v_day.spill_index + 1, 'spillover',
              case when p_status = 'blocked' then v_reason end, v_today)
      returning id into v_new_day_id;

      insert into events (task_id, task_day_id, tracker_id, actor_user_id, origin, field,
                          old_value, new_value, reason)
      values (v_task.id, v_new_day_id, v_task.tracker_id, v_user, 'correction', 'status',
              v_task.status::text, p_status::text, v_reason);
    end if;

    update tasks
    set status = p_status,
        status_reason = case when p_status = 'blocked' then v_reason end,
        completed_on = null,
        hub_changed_at = now(),
        updated_at = now()
    where id = v_task.id;

    -- 10.3: the sheet-reopened conflict is answered by this correction.
    update attention_items
    set state = 'resolved', resolved_at = now()
    where task_id = v_task.id
      and kind = 'conflict'
      and state = 'open'
      and detail ->> 'reason' = 'reopened_in_source';

    v_completed_on := null;
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
