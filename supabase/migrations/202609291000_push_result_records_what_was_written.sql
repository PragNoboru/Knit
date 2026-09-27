-- PRD 10.3, 10.4 step 1 and 5, N8, N17: what push_result records for a finished write-back.
-- Replaces push_result from 20260926101600_push.sql. Service role only.
--
--   * The snapshot is exactly what Knit wrote (10.3). p_snapshot now holds only the mapped
--     cells the push wrote: statusKey when it wrote the status cell, completedOn when it wrote
--     or cleared the completed-on cell. It is merged into the task's source_snapshot, so a
--     value Knit did not write (a status the tracker cannot express, N8, or anything a person
--     changed in the sheet since the last pull) keeps its last pulled value, and the next pull
--     still sees that change. A task with no snapshot yet only takes a complete one.
--   * A note-only write-back (N17) is not a change made in Knit: it is marked done and ends a
--     write_blocked item, but leaves the task's snapshot and source_synced_at alone, so it can
--     never absorb a status changed in the sheet.
--   * Newest per task wins (10.4 step 1), also when pushes overlap: a write-back superseded
--     while its push was in flight can land after the newer one. When such a write reports
--     success and wrote something other than the task's newest write-back, the newest one is
--     queued again so it is written last; the snapshot takes what the stale write put in the
--     sheet (Knit's own write, never a change in the sheet), and the tracker's state_version
--     moves so a pull plan computed before this is recomputed (9.1).
--   * Locks are taken task first, then outbox row, in the order set_task_status takes them.
-- Failures are unchanged: retry after 1, 2, 5 and 15 minutes, then failed with write_blocked;
-- row_not_found and formula_column fail at once with their own attention item.
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
  v_row outbox%rowtype;
  v_note_only boolean;
  v_newest jsonb;
  v_attempts integer;
  v_kind text;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select task_id into v_task_id from outbox where id = p_outbox_id;
  if not found then
    return;
  end if;
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
    when v_attempts >= 5 then 'write_blocked'
  end;

  if v_kind is null then
    update outbox
    set attempts = v_attempts,
        last_error = left(p_error, 500),
        next_attempt_at = now() + make_interval(mins => (array[1, 2, 5, 15])[v_attempts])
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
