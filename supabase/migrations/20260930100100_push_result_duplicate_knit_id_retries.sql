-- PRD 10.4 step 5, N22, invariant 8: a write-back refused because its Knit ID is on more than
-- one row never fails for good.
--
-- N22: when a task's Knit ID is on more than one row (a pasted copy), the push writes nothing
-- and retries the write-back "normal backoff, never a terminal failure" until the pull has
-- given the lower row a new ID (10.2 step 4). So p_error 'duplicate_knit_id' is never turned
-- into write_blocked, however many attempts it took. It waits 1, 2, 5, 15 and then 60 minutes
-- between attempts (the backoff of 10.4 step 5), staying at 60 minutes, and so never loses its
-- next attempt time.
--
-- Everything else is as in 20260929100000_push_result_records_what_was_written.sql: other
-- errors retry after 1, 2, 5 and 15 minutes and then fail with write_blocked; row_not_found
-- and formula_column fail at once with their own attention item.
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
