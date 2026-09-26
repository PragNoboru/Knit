-- PRD 10.4: database side of the push (write-back) job. Service role only.

-- Claims write-backs that are due, for one task or all:
--   1. Newest per task wins; older pending rows become superseded.
--   2. Rows of trackers that are not active are held; held rows of active trackers are pending
--      again (a resumed tracker).
--   3. Due pending rows are claimed for two minutes (next_attempt_at moves forward), so an
--      overlapping push never writes the same row, and a push that dies loses nothing: the row
--      is due again afterwards (invariant 8).
-- Returns, per claimed row, what the push needs: the payload, the task and its task-days (for
-- the Knit Note), and the tracker's sheet and registry.
create function public.push_claim(p_limit integer default 200, p_task_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed bigint[];
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  update outbox o set state = 'superseded'
  where o.state in ('pending', 'held')
    and (p_task_id is null or o.task_id = p_task_id)
    and exists (
      select 1 from outbox newer
      where newer.task_id = o.task_id and newer.state in ('pending', 'held') and newer.id > o.id
    );

  update outbox o set state = 'held'
  from trackers t
  where o.tracker_id = t.id and o.state = 'pending' and t.state <> 'active'
    and (p_task_id is null or o.task_id = p_task_id);

  update outbox o set state = 'pending', next_attempt_at = now()
  from trackers t
  where o.tracker_id = t.id and o.state = 'held' and t.state = 'active'
    and (p_task_id is null or o.task_id = p_task_id);

  with due as (
    select id from outbox
    where state = 'pending' and next_attempt_at <= now()
      and (p_task_id is null or task_id = p_task_id)
    order by next_attempt_at, id
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update outbox o set next_attempt_at = now() + interval '2 minutes'
    from due where o.id = due.id
    returning o.id
  )
  select coalesce(array_agg(id), '{}') into v_claimed from claimed;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'outboxId', o.id::text,
      'payload', o.payload,
      'attempts', o.attempts,
      'tracker', jsonb_build_object(
        'id', t.id, 'fileId', t.file_id, 'sheetGid', t.sheet_gid, 'config', t.config),
      'task', jsonb_build_object(
        'id', k.id, 'status', k.status, 'statusReason', k.status_reason,
        'completedOn', k.completed_on, 'dueDate', k.due_date, 'historyOnly', k.history_only,
        'sourceSnapshot', k.source_snapshot),
      'taskDays', coalesce((
        select jsonb_agg(jsonb_build_object(
          'day', d.day, 'status', d.status, 'spillIndex', d.spill_index, 'locked', d.locked)
          order by d.day)
        from task_days d where d.task_id = k.id), '[]'::jsonb)
    ) order by t.id, o.id)
    from outbox o
    join tasks k on k.id = o.task_id
    join trackers t on t.id = o.tracker_id
    where o.id = any (v_claimed)
  ), '[]'::jsonb);
end;
$$;

-- Records the outcome of one write-back (10.4 step 5).
--   ok: done; the task's source_snapshot (and raw status word) become exactly what the sheet
--       now holds, so Knit's own write is never mistaken for a change in the sheet (10.3).
--   otherwise: attempts + 1 and retry after 1, 2, 5 and 15 minutes; the fifth failure marks it
--       failed with attention write_blocked. `row_not_found` and `formula_column` fail at once
--       with their own attention item: retrying cannot help.
create function public.push_result(
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
  v_row outbox%rowtype;
  v_attempts integer;
  v_kind text;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select * into v_row from outbox where id = p_outbox_id for update;
  if not found or v_row.state not in ('pending', 'held') then
    return;
  end if;

  if p_ok then
    update outbox set state = 'done', done_at = now(), last_error = null where id = p_outbox_id;
    update tasks
    set source_snapshot = coalesce(p_snapshot, source_snapshot),
        source_status_raw = coalesce(p_status_raw, source_status_raw),
        source_synced_at = now()
    where id = v_row.task_id;
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

revoke all on function public.push_claim(integer, uuid) from public, anon, authenticated;
revoke all on function public.push_result(bigint, boolean, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.push_claim(integer, uuid) to service_role;
grant execute on function public.push_result(bigint, boolean, jsonb, text, text) to service_role;
