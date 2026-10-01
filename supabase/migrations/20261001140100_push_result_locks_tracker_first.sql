-- PRD N49, 6.10, 10.4, invariant 8: push_result takes the tracker lock before the task lock.
--
-- In its superseded-and-resent branch (a superseded write-back that landed, 10.4) push_result
-- locked the task, then queued the task's newest write-back again and moved the tracker's
-- state_version, which locks the tracker last. close_day, apply_pull_plan, set_task_status,
-- backlog_action and admin_correct_task_day all take the tracker first (N49,
-- 20261001100610_status_rpcs_lock_tracker_first.sql). Two transactions taking the same locks in
-- opposite orders can deadlock, and Postgres then aborts one of them (40P01).
--
--   * push_result reads the write-back's tracker without a lock and locks it before the task,
--     on every call: whether the branch that moves state_version runs is known only once the
--     outbox row is locked, after the task. A write-back that does not exist locks nothing.
--
-- Nothing else changes: push_result is as in 20260930100100_push_result_duplicate_knit_id_retries.sql,
-- with its grants.

create or replace function public.push_result(
  p_outbox_id bigint,
  p_ok boolean,
  p_snapshot jsonb default null,
  p_error text default null,
  p_status_raw text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task_id uuid;
  v_tracker_id uuid;
  v_row outbox%rowtype;
  v_note_only boolean;
  v_newest jsonb;
  v_attempts integer;
  v_kind text;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select task_id, tracker_id into v_task_id, v_tracker_id from outbox where id = p_outbox_id;
  if not found then
    return;
  end if;
  -- N49: the tracker first, then the task, then the write-back.
  perform 1 from trackers where id = v_tracker_id for update;
  perform 1 from tasks where id = v_task_id for update;
  select * into v_row from outbox where id = p_outbox_id for update;
  v_note_only := coalesce((v_row.payload ->> 'note_only')::boolean, false);

  if v_row.state = 'superseded' then
    if not p_ok then
      return;
    end if;
    -- The task's newest write-back: its newest status write-back, else its newest note refresh.
    select n.payload into v_newest
    from outbox n
    where n.task_id = v_row.task_id and n.id > v_row.id
    order by coalesce((n.payload ->> 'note_only')::boolean, false), n.id desc
    limit 1;
    if not found or v_newest = v_row.payload then
      return;
    end if;
    insert into outbox (task_id, tracker_id, payload)
    values (v_row.task_id, v_row.tracker_id, v_newest);
    if not v_note_only then
      update tasks
      set source_snapshot = case
            when p_snapshot is null then source_snapshot
            when source_snapshot is null then
              case when p_snapshot ?& array['statusKey', 'completedOn'] then p_snapshot end
            else source_snapshot || p_snapshot
          end,
          source_status_raw = coalesce(p_status_raw, source_status_raw)
      where id = v_row.task_id;
    end if;
    update trackers set state_version = state_version + 1 where id = v_row.tracker_id;
    return;
  end if;

  if v_row.state not in ('pending', 'held') then
    return;
  end if;

  if p_ok then
    update outbox set state = 'done', done_at = now(), last_error = null where id = p_outbox_id;
    if not v_note_only then
      update tasks
      set source_snapshot = case
            when p_snapshot is null then source_snapshot
            when source_snapshot is null then
              case when p_snapshot ?& array['statusKey', 'completedOn'] then p_snapshot end
            else source_snapshot || p_snapshot
          end,
          source_status_raw = coalesce(p_status_raw, source_status_raw),
          source_synced_at = now()
      where id = v_row.task_id;
    end if;
    -- An earlier write_blocked item for this task is over once a write lands.
    update attention_items set state = 'resolved', resolved_at = now()
    where task_id = v_row.task_id and kind = 'write_blocked' and state = 'open';
    return;
  end if;

  v_attempts := v_row.attempts + 1;
  v_kind := case
    when p_error in ('row_not_found', 'formula_column') then p_error
    -- N22: waits for the pull to give the pasted copy a new Knit ID; never terminal.
    when p_error = 'duplicate_knit_id' then null
    when v_attempts >= 5 then 'write_blocked'
  end;

  if v_kind is null then
    update outbox
    set attempts = v_attempts,
        last_error = left(p_error, 500),
        next_attempt_at = now()
          + make_interval(mins => (array[1, 2, 5, 15, 60])[least(v_attempts, 5)])
    where id = p_outbox_id;
    return;
  end if;

  update outbox set state = 'failed', attempts = v_attempts, last_error = left(p_error, 500)
  where id = p_outbox_id;
  insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
  values (v_row.tracker_id, v_row.task_id, v_kind, v_kind || ':' || v_row.task_id,
          jsonb_build_object('error', left(p_error, 200), 'attempts', v_attempts))
  on conflict (tracker_id, dedupe_key) where state = 'open' do nothing;
end;
$$;

revoke all on function public.push_result(bigint, boolean, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.push_result(bigint, boolean, jsonb, text, text) to service_role;
