-- PRD 10.4 step 2, N11, N30, N59: push_claim says whether each claimed task was removed at
-- source.
--
-- A row whose Knit ID belongs to a task removed at source is a new task (N30): the pull gives
-- it a new Knit ID. Until it does, the row still carries the removed task's Knit ID, so a
-- write-back of the removed task (a pending retry, or one queued later by
-- admin_correct_task_day) would find that row and write the removed task's values into it,
-- which the new task would then read. The push therefore fails every write-back of a task
-- removed at source with row_not_found without looking for its row (N59). For that it needs
-- `removedAtSource` in the claimed task.
--
-- Everything else is exactly as in 20260926101700_close_job.sql, the latest definition: the
-- N17 supersede rules (a status write-back beats a note-only one; among the same kind the
-- newest wins), holding and releasing on paused trackers, and the two-minute claim.
-- Forward-only: the earlier definitions are not edited.

-- N17: when a task has several write-backs waiting, a status write-back always beats a
-- note-only one (its push writes the current note too); among the same kind the newest wins.
create or replace function public.push_claim(p_limit integer default 200, p_task_id uuid default null)
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
      select 1 from outbox keep
      where keep.task_id = o.task_id and keep.state in ('pending', 'held') and keep.id <> o.id
        and (
          (not coalesce((keep.payload ->> 'note_only')::boolean, false)
            and (coalesce((o.payload ->> 'note_only')::boolean, false) or keep.id > o.id))
          or (coalesce((keep.payload ->> 'note_only')::boolean, false)
            and coalesce((o.payload ->> 'note_only')::boolean, false) and keep.id > o.id)
        )
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
        'sourceSnapshot', k.source_snapshot,
        -- N59: the push fails a write-back of a task removed at source with row_not_found.
        'removedAtSource', k.removed_at_source is not null),
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

-- Service role only, as before.
revoke all on function public.push_claim(integer, uuid) from public, anon, authenticated;
grant execute on function public.push_claim(integer, uuid) to service_role;
