-- PRD 10.5, 10.6, 10.7, 19: database side of the close-days job. Service role only.

-- The oldest day before today (IST) that has not been closed, counting from the earliest
-- go-live date of any tracker that is not a draft. Null when there is nothing to close.
create function public.next_day_to_close()
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select min(g.d)::date
  from generate_series(
         (select min(go_live_date) from trackers where state <> 'draft')::timestamp,
         (knit_today() - 1)::timestamp,
         interval '1 day') as g (d)
  where not exists (select 1 from day_closures c where c.day = g.d::date and c.state = 'closed')
$$;

-- 10.5 step 2: marks D as running (again, after a failure). Idempotent.
create function public.begin_day_closure(p_day date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into day_closures (day, state, started_at)
  values (p_day, 'running', now())
  on conflict (day) do update
    set state = 'running', started_at = now(), error = null
    where day_closures.state <> 'closed';
end;
$$;

-- 10.5 step 2, 19: D is closed; stats hold task-days locked, spillovers, mismatches.
create function public.finish_day_closure(p_day date, p_stats jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update day_closures set state = 'closed', closed_at = now(), stats = p_stats, error = null
  where day = p_day;
end;
$$;

-- 10.5 step 3: a failed step leaves D failed with the error; the next call starts again.
create function public.fail_day_closure(p_day date, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into day_closures (day, state, error) values (p_day, 'failed', left(p_error, 1000))
  on conflict (day) do update set state = 'failed', error = left(p_error, 1000)
  where day_closures.state <> 'closed';
end;
$$;

-- 10.5 step 2, N17: queue Knit Note refreshes for the tasks a close touched. These rows carry
-- {"note_only": true}: the push writes only the Knit Note cell, and they never count as a
-- change made in Knit (10.3), so they cannot override a status changed in the sheet. A task
-- that already has a write-back waiting is skipped: that push writes the current note too.
create function public.enqueue_note_refresh(p_task_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into outbox (task_id, tracker_id, payload)
  select k.id, k.tracker_id, '{"note_only": true}'::jsonb
  from tasks k
  join trackers t on t.id = k.tracker_id
  where k.id = any (p_task_ids)
    and k.removed_at_source is null
    and t.state in ('active', 'paused')
    and not exists (select 1 from outbox o where o.task_id = k.id and o.state in ('pending', 'held'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 10.7: the rows the Knit Archive keeps for day D: its task-days, and the events recorded on D
-- (in IST).
create function public.archive_rows(p_day date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'taskDays', coalesce((
      select jsonb_agg(jsonb_build_array(
        d.day, d.id, d.task_id, t.name, k.source_ref, k.title, d.status, d.carried_status,
        d.spill_index, d.origin, d.reason, d.locked_at) order by t.name, k.title, d.id)
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day = p_day), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_array(
        p_day, e.id, e.at, e.task_id, t.name, e.origin, e.field, e.old_value, e.new_value,
        e.reason, u.name) order by e.at, e.id)
      from events e
      left join trackers t on t.id = e.tracker_id
      left join app_users u on u.id = e.actor_user_id
      where (e.at at time zone 'Asia/Kolkata')::date = p_day), '[]'::jsonb)
  )
$$;

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

-- 10.5 step 2: whether active trackers still have write-backs due (the close pushes first).
create function public.outbox_due_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
  from outbox o join trackers t on t.id = o.tracker_id
  where o.state = 'pending' and t.state = 'active' and o.next_attempt_at <= now()
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'next_day_to_close()',
    'begin_day_closure(date)',
    'finish_day_closure(date, jsonb)',
    'fail_day_closure(date, text)',
    'enqueue_note_refresh(uuid[])',
    'archive_rows(date)',
    'outbox_due_count()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
