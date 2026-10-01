-- PRD N63, 6.11, N17, D7, 6.9, invariant 8: Bring to today refreshes the sheet's Knit Note.
--
-- Bring to today cleared history_only but queued no write-back, so the sheet's Knit Note kept
-- saying "Before Knit go-live" until Knit next wrote the row: a status change made in Knit, or
-- the close of the day the task-day is on.
--
--   * In the same transaction, each task Bring to today brings gets a note-only write-back
--     ({"note_only": true}) under the rules of enqueue_note_refresh (N17): the tracker is
--     active or paused, the task is not removed at source, and a task that already has a
--     write-back waiting (pending or held) gets none, since that push writes the current note.
--     enqueue_note_refresh itself only serves the jobs (knit_is_trusted), and backlog_action
--     runs for the admin, so the row is inserted here, as the holiday trigger does (N53).
--   * The push renders the note when it writes (6.9), so it reads as a task-day on its day
--     (for example "Spilled 1x · now due Thu 1 Oct · In progress").
--   * Lock order is unchanged (N49): the outbox row takes FOR KEY SHARE on the tracker and the
--     task, both already locked FOR UPDATE.
--
-- Nothing else changes: backlog_action is as in 20261001140400_backlog_bring_to_working_day.sql,
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
      -- N61: the first working day on or after the later of today and go-live (6.11).
      -- is_working_day and next_working_day raise calendar_not_covered past the calendar.
      select greatest(t.go_live_date, v_today) into v_day
      from trackers t where t.id = v_task.tracker_id;
      if not is_working_day(v_day) then
        v_day := next_working_day(v_day);
      end if;
      insert into task_days (task_id, day, status, spill_index, origin, reason)
      values (v_task.id, v_day, v_task.status, 1, 'backlog',
              case when v_task.status = 'blocked' then v_task.status_reason end)
      on conflict (task_id, day) do nothing;
      update tasks set history_only = false, updated_at = now() where id = v_task.id;
      insert into events (task_id, tracker_id, actor_user_id, origin, field, old_value, new_value)
      values (v_task.id, v_task.tracker_id, v_user, 'hub', 'backlog', 'history_only', 'brought_to_today');
      -- N63, N17: a note-only write-back, so the sheet's Knit Note stops saying Before Knit
      -- go-live. Same rules as enqueue_note_refresh: tracker active or paused, task not
      -- removed at source (the loop already requires it), none when a write-back is waiting.
      insert into outbox (task_id, tracker_id, payload)
      select v_task.id, v_task.tracker_id, '{"note_only": true}'::jsonb
      from trackers t
      where t.id = v_task.tracker_id
        and t.state in ('active', 'paused')
        and not exists (
          select 1 from outbox o where o.task_id = v_task.id and o.state in ('pending', 'held'));
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
