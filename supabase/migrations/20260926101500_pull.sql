-- PRD 10.1, 10.2: database side of discover and pull. Every function here is for the jobs:
-- service role only, security definer, and safe to run twice.

-- What the pull needs to normalise rows: the calendar and the people aliases.
create function public.load_sync_context()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'calendar', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'isWorking', is_working, 'reason', reason) order by day)
      from calendar_days), '[]'::jsonb),
    'aliases', coalesce((
      select jsonb_agg(jsonb_build_object('aliasNorm', alias_norm, 'userId', user_id))
      from people_aliases), '[]'::jsonb)
  )
$$;

-- Trackers for the jobs: every tracker in the given states (default: active), optionally only
-- the given ids.
create function public.sync_trackers(p_states tracker_state[] default null, p_ids uuid[] default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'fileId', file_id, 'sheetGid', sheet_gid, 'tabName', tab_name, 'name', name,
    'state', state, 'config', config, 'goLiveDate', go_live_date, 'ownerUserId', owner_user_id,
    'stateVersion', state_version, 'lastSourceModifiedTime', last_source_modified_time
  ) order by name), '[]'::jsonb)
  from trackers
  where state = any (coalesce(p_states, array['active']::tracker_state[]))
    and (p_ids is null or id = any (p_ids))
$$;

-- 10.2 step 6: the database side of one tracker for planPull. `hubChanged` follows 10.3: the hub
-- changed the status after the last sync, or a write-back is still waiting (note-only
-- refreshes do not count).
create function public.load_pull_state(p_tracker_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'stateVersion', t.state_version,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', k.id, 'title', k.title, 'subtitle', k.subtitle, 'details', k.details,
        'sourceRef', k.source_ref, 'critical', k.critical, 'ownerRaw', k.owner_raw,
        'plannedRaw', k.planned_raw, 'rowHint', k.row_hint, 'dateKind', k.date_kind,
        'plannedStart', k.planned_start, 'plannedEnd', k.planned_end, 'dueDate', k.due_date,
        'status', k.status, 'statusReason', k.status_reason, 'sourceStatusRaw', k.source_status_raw,
        'completedOn', k.completed_on, 'historyOnly', k.history_only,
        'removedAtSource', k.removed_at_source is not null,
        'sourceSnapshot', k.source_snapshot,
        'hubChanged',
          (k.hub_changed_at is not null
            and (k.source_synced_at is null or k.hub_changed_at > k.source_synced_at))
          or exists (
            select 1 from outbox o
            where o.task_id = k.id and o.state in ('pending', 'held')
              and not coalesce((o.payload ->> 'note_only')::boolean, false)),
        'assignees', coalesce((
          select jsonb_agg(a.user_id order by a.user_id) from task_assignees a where a.task_id = k.id),
          '[]'::jsonb),
        'taskDays', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', d.id::text, 'day', d.day, 'status', d.status, 'spillIndex', d.spill_index,
            'origin', d.origin, 'reason', d.reason, 'locked', d.locked) order by d.day)
          from task_days d where d.task_id = k.id), '[]'::jsonb)
      ))
      from tasks k where k.tracker_id = t.id), '[]'::jsonb)
  )
  from trackers t
  where t.id = p_tracker_id
$$;

-- 10.2 step 4: Knit IDs that already belong to another tracker (a row copied between sheets).
-- The pull treats them like duplicates and gives those rows new IDs.
create function public.knit_ids_elsewhere(p_tracker_id uuid, p_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(id), '{}') from tasks where id = any (p_ids) and tracker_id <> p_tracker_id
$$;

-- 10.2 step 7: applies a pull plan (from planPull) in one transaction. When the tracker's
-- state_version moved since the plan was computed (a status changed in Knit meanwhile), or
-- the plan was made for an earlier day, nothing is applied and the answer is 'retry'.
-- Locked task-days are never changed. The tracker's last pull time and the sheet's modified
-- time are recorded.
create function public.apply_pull_plan(
  p_tracker_id uuid,
  p_expected_state_version bigint,
  p_plan jsonb,
  p_run_id bigint default null,
  p_source_modified_time timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_version bigint;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select state_version into v_version from trackers where id = p_tracker_id for update;
  if not found then
    raise exception 'tracker_not_found';
  end if;
  if v_version <> p_expected_state_version or (p_plan ->> 'today')::date <> knit_today() then
    return jsonb_build_object('result', 'retry');
  end if;

  insert into tasks (
    id, tracker_id, source_ref, row_hint, title, subtitle, details, planned_raw, date_kind,
    planned_start, planned_end, due_date, critical, owner_raw, status, status_reason,
    source_status_raw, completed_on, history_only, source_snapshot, source_synced_at
  )
  select (t ->> 'id')::uuid, p_tracker_id, t ->> 'sourceRef', (t ->> 'rowHint')::int,
         t ->> 'title', t ->> 'subtitle', coalesce(t -> 'details', '{}'::jsonb), t ->> 'plannedRaw',
         (t ->> 'dateKind')::date_kind, (t ->> 'plannedStart')::date, (t ->> 'plannedEnd')::date,
         (t ->> 'dueDate')::date, coalesce((t ->> 'critical')::boolean, false), t ->> 'ownerRaw',
         (t ->> 'status')::knit_status, t ->> 'statusReason', t ->> 'sourceStatusRaw',
         (t ->> 'completedOn')::date, coalesce((t ->> 'historyOnly')::boolean, false),
         t -> 'sourceSnapshot', now()
  from jsonb_array_elements(coalesce(p_plan -> 'taskInserts', '[]'::jsonb)) t
  on conflict (id) do nothing;

  update tasks k set
    title = case when u.s ? 'title' then u.s ->> 'title' else k.title end,
    subtitle = case when u.s ? 'subtitle' then u.s ->> 'subtitle' else k.subtitle end,
    details = case when u.s ? 'details' then u.s -> 'details' else k.details end,
    source_ref = case when u.s ? 'sourceRef' then u.s ->> 'sourceRef' else k.source_ref end,
    critical = case when u.s ? 'critical' then (u.s ->> 'critical')::boolean else k.critical end,
    owner_raw = case when u.s ? 'ownerRaw' then u.s ->> 'ownerRaw' else k.owner_raw end,
    planned_raw = case when u.s ? 'plannedRaw' then u.s ->> 'plannedRaw' else k.planned_raw end,
    row_hint = case when u.s ? 'rowHint' then (u.s ->> 'rowHint')::int else k.row_hint end,
    date_kind = case when u.s ? 'dateKind' then (u.s ->> 'dateKind')::date_kind else k.date_kind end,
    planned_start = case when u.s ? 'plannedStart' then (u.s ->> 'plannedStart')::date else k.planned_start end,
    planned_end = case when u.s ? 'plannedEnd' then (u.s ->> 'plannedEnd')::date else k.planned_end end,
    due_date = case when u.s ? 'dueDate' then (u.s ->> 'dueDate')::date else k.due_date end,
    status = case when u.s ? 'status' then (u.s ->> 'status')::knit_status else k.status end,
    status_reason = case when u.s ? 'statusReason' then u.s ->> 'statusReason' else k.status_reason end,
    source_status_raw = case when u.s ? 'sourceStatusRaw' then u.s ->> 'sourceStatusRaw' else k.source_status_raw end,
    completed_on = case when u.s ? 'completedOn' then (u.s ->> 'completedOn')::date else k.completed_on end,
    history_only = case when u.s ? 'historyOnly' then (u.s ->> 'historyOnly')::boolean else k.history_only end,
    source_snapshot = case when u.s ? 'sourceSnapshot' then u.s -> 'sourceSnapshot' else k.source_snapshot end,
    removed_at_source = case when u.s ? 'removedAtSource' then null else k.removed_at_source end,
    source_synced_at = case when u.synced then now() else k.source_synced_at end,
    updated_at = now()
  from (
    select (x ->> 'id')::uuid as id, x -> 'set' as s, coalesce((x ->> 'sourceSynced')::boolean, false) as synced
    from jsonb_array_elements(coalesce(p_plan -> 'taskUpdates', '[]'::jsonb)) x
  ) u
  where k.id = u.id and k.tracker_id = p_tracker_id;

  -- 6.6 "Row deleted".
  update tasks
  set removed_at_source = now(), updated_at = now()
  where tracker_id = p_tracker_id
    and removed_at_source is null
    and id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p_plan -> 'removals', '[]'::jsonb)) x);

  update task_days d set
    day = coalesce((u.s ->> 'day')::date, d.day),
    status = coalesce((u.s ->> 'status')::knit_status, d.status),
    reason = case when u.s ? 'reason' then u.s ->> 'reason' else d.reason end,
    status_changed_on = coalesce((u.s ->> 'statusChangedOn')::date, d.status_changed_on),
    spill_index = coalesce((u.s ->> 'spillIndex')::int, d.spill_index),
    origin = coalesce(u.s ->> 'origin', d.origin)
  from (
    select (x ->> 'id')::bigint as id, x -> 'set' as s
    from jsonb_array_elements(coalesce(p_plan -> 'taskDayUpdates', '[]'::jsonb)) x
  ) u
  where d.id = u.id
    and not d.locked
    and d.task_id in (select id from tasks where tracker_id = p_tracker_id);

  insert into task_days (task_id, day, status, spill_index, origin, reason, status_changed_on)
  select (x ->> 'taskId')::uuid, (x ->> 'day')::date, (x ->> 'status')::knit_status,
         (x ->> 'spillIndex')::int, x ->> 'origin', x ->> 'reason', (x ->> 'statusChangedOn')::date
  from jsonb_array_elements(coalesce(p_plan -> 'taskDayInserts', '[]'::jsonb)) x
  where exists (select 1 from tasks where id = (x ->> 'taskId')::uuid and tracker_id = p_tracker_id)
  on conflict (task_id, day) do nothing;

  -- 6.7: assignees are replaced as a set for the tasks listed.
  with sets as (
    select (x ->> 'taskId')::uuid as task_id,
           array(select (v #>> '{}')::uuid from jsonb_array_elements(x -> 'userIds') v) as users
    from jsonb_array_elements(coalesce(p_plan -> 'assigneeSets', '[]'::jsonb)) x
  ),
  removed as (
    delete from task_assignees a
    using sets s
    where a.task_id = s.task_id and not (a.user_id = any (s.users))
    returning 1
  )
  insert into task_assignees (task_id, user_id)
  select s.task_id, u.user_id
  from sets s cross join lateral unnest(s.users) as u (user_id)
  where exists (select 1 from tasks where id = s.task_id and tracker_id = p_tracker_id)
  on conflict do nothing;

  -- 10.3: the hub's value stays; make sure its write-back is queued.
  insert into outbox (task_id, tracker_id, payload)
  select (x ->> 'taskId')::uuid, p_tracker_id,
         jsonb_build_object('status_value', x -> 'statusValue', 'completed_on', x -> 'completedOn')
  from jsonb_array_elements(coalesce(p_plan -> 'outbox', '[]'::jsonb)) x
  where not exists (
    select 1 from outbox o
    where o.task_id = (x ->> 'taskId')::uuid and o.state in ('pending', 'held')
      and not coalesce((o.payload ->> 'note_only')::boolean, false)
  );

  insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
  select p_tracker_id, (x ->> 'taskId')::uuid, x ->> 'kind', x ->> 'dedupeKey',
         coalesce(x -> 'detail', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_plan -> 'attention', '[]'::jsonb)) x
  where x ->> 'taskId' is null
     or exists (select 1 from tasks where id = (x ->> 'taskId')::uuid)
  on conflict (tracker_id, dedupe_key) where state = 'open' do nothing;

  insert into events (task_id, task_day_id, tracker_id, origin, field, old_value, new_value, reason)
  select (x ->> 'taskId')::uuid, (x ->> 'taskDayId')::bigint, p_tracker_id, 'source',
         x ->> 'field', x ->> 'oldValue', x ->> 'newValue', x ->> 'reason'
  from jsonb_array_elements(coalesce(p_plan -> 'events', '[]'::jsonb)) x
  where exists (select 1 from tasks where id = (x ->> 'taskId')::uuid and tracker_id = p_tracker_id);

  update trackers
  set last_pull_at = now(),
      last_source_modified_time = coalesce(p_source_modified_time, last_source_modified_time)
  where id = p_tracker_id;

  return jsonb_build_object('result', 'applied', 'stats', coalesce(p_plan -> 'stats', '{}'::jsonb));
end;
$$;

-- 10.1: records a complete listing of the Knit folder. New native sheets are 'new', other
-- files 'not_a_sheet'. A file seen before and missing now has left the folder: its trackers
-- pause with the reason "Left the Knit folder" and keep their data. A file that comes back is
-- 'connected' again; its trackers stay paused until the admin resumes them.
create function public.record_drive_listing(p_files jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sheet constant text := 'application/vnd.google-apps.spreadsheet';
  v_listed text[];
  v_new integer;
  v_left integer;
  v_paused integer;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select coalesce(array_agg(f ->> 'id'), '{}') into v_listed from jsonb_array_elements(p_files) f;

  with upserted as (
    insert into drive_files (file_id, name, mime_type, modified_time, state, last_seen_at)
    select f ->> 'id', f ->> 'name', f ->> 'mimeType', (f ->> 'modifiedTime')::timestamptz,
           case when f ->> 'mimeType' = v_sheet then 'new' else 'not_a_sheet' end::drive_file_state,
           now()
    from jsonb_array_elements(p_files) f
    on conflict (file_id) do update set
      name = excluded.name,
      mime_type = excluded.mime_type,
      modified_time = excluded.modified_time,
      last_seen_at = now(),
      state = case
        when excluded.mime_type <> v_sheet then 'not_a_sheet'::drive_file_state
        when exists (select 1 from trackers t where t.file_id = drive_files.file_id)
          then 'connected'::drive_file_state
        when drive_files.state in ('left_folder', 'not_a_sheet') then 'new'::drive_file_state
        else drive_files.state
      end
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_new from upserted;

  with left_files as (
    update drive_files set state = 'left_folder'
    where state <> 'left_folder' and not (file_id = any (v_listed))
    returning file_id
  ),
  paused as (
    update trackers set state = 'paused', pause_reason = 'Left the Knit folder'
    where file_id in (select file_id from left_files) and state = 'active'
    returning 1
  )
  select (select count(*) from left_files), (select count(*) from paused) into v_left, v_paused;

  return jsonb_build_object('listed', coalesce(array_length(v_listed, 1), 0), 'new', v_new,
                            'left', v_left, 'paused', v_paused);
end;
$$;

-- 10.2 step 2, 14: pauses a tracker (when active) and raises the matching attention item.
create function public.pause_tracker(
  p_tracker_id uuid,
  p_reason text,
  p_kind text,
  p_dedupe_key text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update trackers set state = 'paused', pause_reason = p_reason
  where id = p_tracker_id and state = 'active';
  insert into attention_items (tracker_id, kind, dedupe_key, detail)
  values (p_tracker_id, p_kind, p_dedupe_key, coalesce(p_detail, '{}'::jsonb))
  on conflict (tracker_id, dedupe_key) where state = 'open' do nothing;
end;
$$;

-- One Needs Attention item per tracker and dedupe key while it is open.
create function public.raise_attention(
  p_tracker_id uuid,
  p_task_id uuid,
  p_kind text,
  p_dedupe_key text,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
  values (p_tracker_id, p_task_id, p_kind, p_dedupe_key, coalesce(p_detail, '{}'::jsonb))
  on conflict (tracker_id, dedupe_key) where state = 'open' do nothing;
end;
$$;

-- 19: one sync_runs row per job call.
create function public.start_sync_run(p_job text, p_tracker_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into sync_runs (job, tracker_id) values (p_job, p_tracker_id) returning id into v_id;
  return v_id;
end;
$$;

create function public.finish_sync_run(p_id bigint, p_ok boolean, p_stats jsonb, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update sync_runs set finished_at = now(), ok = p_ok, stats = p_stats, error = p_error where id = p_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'load_sync_context()',
    'sync_trackers(tracker_state[], uuid[])',
    'load_pull_state(uuid)',
    'knit_ids_elsewhere(uuid, uuid[])',
    'apply_pull_plan(uuid, bigint, jsonb, bigint, timestamptz)',
    'record_drive_listing(jsonb)',
    'pause_tracker(uuid, text, text, text, jsonb)',
    'raise_attention(uuid, uuid, text, text, jsonb)',
    'start_sync_run(text, uuid)',
    'finish_sync_run(bigint, boolean, jsonb, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end;
$$;
