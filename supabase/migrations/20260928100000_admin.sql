-- PRD 11, 12.8, 13 (M8): what the admin screens read and the admin actions that are rules
-- rather than plain saves. Admin functions are security definer and check knit_is_admin()
-- themselves (9.1); tracker state changes run from admin server actions with the service
-- role (9.2 "writes through admin server actions"), after those check the caller is the admin.

-- 12.8 Trackers: every tracker with its counts, and the files of the Knit folder that are not
-- trackers yet (10.1: New sheet found, and files that are not Google Sheets, 14).
create function public.admin_trackers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'trackers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'color', t.color, 'state', t.state,
        'pauseReason', t.pause_reason, 'fileId', t.file_id, 'gid', t.sheet_gid,
        'tabName', t.tab_name, 'fileName', f.name, 'lastPullAt', t.last_pull_at,
        'goLiveDate', t.go_live_date,
        'taskCount', (select count(*) from tasks k where k.tracker_id = t.id and k.removed_at_source is null),
        'backlogCount', (select count(*) from tasks k where k.tracker_id = t.id and k.history_only
                           and k.removed_at_source is null and k.status not in ('done', 'cancelled')),
        'openAttention', (select count(*) from attention_items a where a.tracker_id = t.id and a.state = 'open')
      ) order by t.state = 'archived', t.name)
      from trackers t join drive_files f on f.file_id = t.file_id), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'fileId', f.file_id, 'name', f.name, 'state', f.state, 'modifiedTime', f.modified_time,
        'trackers', (select count(*) from trackers t where t.file_id = f.file_id and t.state <> 'archived'))
        order by f.name)
      from drive_files f
      where f.state in ('new', 'ignored', 'not_a_sheet')
         or (f.state = 'connected' and not exists (
               select 1 from trackers t where t.file_id = f.file_id and t.state <> 'draft'))), '[]'::jsonb)
  );
end;
$$;

-- 10.1, 11 step 1: Ignore a new sheet, or bring an ignored one back.
create function public.admin_set_file_state(p_file_id text, p_state drive_file_state)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_state not in ('new', 'ignored') then
    raise exception 'invalid_state' using errcode = '22023';
  end if;
  update drive_files set state = p_state
  where file_id = p_file_id and state in ('new', 'ignored');
end;
$$;

-- 12.8 tracker actions and 11 step 9. Allowed moves: a draft is activated (or discarded as
-- archived); an active tracker is paused or archived; a paused one resumes or is archived.
-- Resuming releases the write-backs held while it was paused (10.4) and closes its structure
-- items (the next pull raises them again if the sheet is still wrong).
create function public.set_tracker_state(
  p_tracker_id uuid,
  p_state tracker_state,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old tracker_state;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select state into v_old from trackers where id = p_tracker_id for update;
  if not found then
    raise exception 'tracker_not_found' using errcode = 'P0002';
  end if;
  if v_old = p_state then
    return;
  end if;
  if not (
    (v_old = 'draft' and p_state in ('active', 'archived'))
    or (v_old = 'active' and p_state in ('paused', 'archived'))
    or (v_old = 'paused' and p_state in ('active', 'archived'))
  ) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  update trackers
  set state = p_state,
      pause_reason = case when p_state = 'paused' then coalesce(nullif(btrim(p_reason), ''), 'Paused by the admin') end
  where id = p_tracker_id;

  if v_old = 'paused' and p_state = 'active' then
    update outbox set state = 'pending', next_attempt_at = now()
    where tracker_id = p_tracker_id and state = 'held';
    update attention_items set state = 'resolved', resolved_at = now()
    where tracker_id = p_tracker_id and state = 'open'
      and kind in ('missing_header', 'missing_knit_id_column');
  end if;
end;
$$;

-- 12.8 Sync health: the last 50 job runs, write-backs by state, the last 14 days' closes and
-- how far the calendar reaches (6.2: warn 60 days ahead).
create function public.admin_sync_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today constant date := knit_today();
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'today', v_today,
    'runs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'job', r.job, 'tracker', t.name, 'startedAt', r.started_at,
        'finishedAt', r.finished_at, 'ok', r.ok, 'stats', r.stats, 'error', r.error)
        order by r.started_at desc, r.id desc)
      from (select * from sync_runs order by started_at desc, id desc limit 50) r
      left join trackers t on t.id = r.tracker_id), '[]'::jsonb),
    'outbox', (
      select jsonb_build_object(
        'pending', count(*) filter (where state = 'pending'),
        'held', count(*) filter (where state = 'held'),
        'failed', count(*) filter (where state = 'failed'),
        'done', count(*) filter (where state = 'done'),
        'superseded', count(*) filter (where state = 'superseded'))
      from outbox),
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', c.day, 'state', c.state, 'startedAt', c.started_at, 'closedAt', c.closed_at,
        'stats', c.stats, 'error', c.error) order by c.day desc)
      from day_closures c where c.day >= v_today - 14), '[]'::jsonb),
    'calendarEnd', (select max(day) from calendar_days),
    'openAttention', (select count(*) from attention_items where state = 'open')
  );
end;
$$;

-- 10.4, 12.8: Retry failed write-backs (all, or one task's). Their write_blocked and
-- row_not_found items close; a new failure raises them again.
create function public.admin_retry_writes(p_task_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  with retried as (
    update outbox o
    set state = case when t.state = 'active' then 'pending' else 'held' end::outbox_state,
        attempts = 0, next_attempt_at = now(), last_error = null
    from trackers t
    where t.id = o.tracker_id and o.state = 'failed'
      and (p_task_id is null or o.task_id = p_task_id)
      -- Only the newest write-back of a task is retried; older ones are out of date.
      and not exists (select 1 from outbox n where n.task_id = o.task_id and n.id > o.id
                        and not coalesce((n.payload ->> 'note_only')::boolean, false))
    returning o.task_id
  )
  select count(*) into v_count from retried;
  update attention_items set state = 'resolved', resolved_at = now()
  where state = 'open' and kind in ('write_blocked', 'row_not_found')
    and (p_task_id is null or task_id = p_task_id);
  return v_count;
end;
$$;

-- 12.8 Needs Attention: open items with where they happened.
create function public.admin_attention()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'detail', a.detail, 'createdAt', a.created_at,
      'tracker', case when t.id is null then null else jsonb_build_object(
        'id', t.id, 'name', t.name, 'color', t.color, 'fileId', t.file_id, 'gid', t.sheet_gid,
        'state', t.state) end,
      'task', case when k.id is null then null else jsonb_build_object(
        'id', k.id, 'title', k.title, 'rowHint', k.row_hint) end,
      'reporter', (select u.name from app_users u where u.id = (a.detail ->> 'userId')::uuid))
      order by t.name nulls first, a.kind, a.created_at)
    from attention_items a
    left join trackers t on t.id = a.tracker_id
    left join tasks k on k.id = a.task_id
    where a.state = 'open'), '[]'::jsonb);
end;
$$;

-- 12.8: Dismiss an item, or mark it resolved.
create function public.admin_set_attention_state(p_id bigint, p_state text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_state not in ('resolved', 'dismissed') then
    raise exception 'invalid_state' using errcode = '22023';
  end if;
  update attention_items set state = p_state, resolved_at = now()
  where id = p_id and state = 'open';
end;
$$;

-- 6.11 backlog review: history-only rows the source still has open.
create function public.admin_backlog(p_tracker_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(knit_task_card(k, t, null::task_days)
                     order by k.due_date nulls last, k.title)
    from tasks k join trackers t on t.id = k.tracker_id
    where k.tracker_id = p_tracker_id and k.history_only and k.removed_at_source is null
      and k.status not in ('done', 'cancelled')), '[]'::jsonb);
end;
$$;

-- 6.11, 9.1: bulk actions on history-only rows. Bring to today gives the task a task-day on
-- today (spill 1, origin backlog) and makes it a normal task; Mark done and Cancel (reason
-- required, D2) change its status as set_task_status would, with a write-back, and it stays
-- history only. Rows that are not history-only open rows are skipped.
create function public.backlog_action(
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

  for v_task in
    select * from tasks
    where id = any (p_task_ids) and history_only and removed_at_source is null
      and status not in ('done', 'cancelled')
    order by id
    for update
  loop
    if p_action = 'bring_to_today' then
      insert into task_days (task_id, day, status, spill_index, origin, reason)
      values (v_task.id, v_today, v_task.status, 1, 'backlog',
              case when v_task.status = 'blocked' then v_task.status_reason end)
      on conflict (task_id, day) do nothing;
      update tasks set history_only = false, updated_at = now() where id = v_task.id;
      insert into events (task_id, tracker_id, actor_user_id, origin, field, old_value, new_value)
      values (v_task.id, v_task.tracker_id, v_user, 'hub', 'backlog', 'history_only', 'brought_to_today');
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

-- 12.8 Holidays: how many open tasks a holiday on this date would touch, for the warning.
create function public.holiday_impact(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'openTaskDays', (select count(*) from task_days where day = p_day and not locked),
    'lockedTaskDays', (select count(*) from task_days where day = p_day and locked),
    'plannedTasks', (
      select count(*) from tasks
      where removed_at_source is null and not history_only
        and status not in ('done', 'cancelled')
        and p_day between planned_start and coalesce(planned_end, planned_start))
  );
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'admin_trackers()',
    'admin_set_file_state(text, public.drive_file_state)',
    'admin_sync_health()',
    'admin_retry_writes(uuid)',
    'admin_attention()',
    'admin_set_attention_state(bigint, text)',
    'admin_backlog(uuid)',
    'backlog_action(uuid[], text, text)',
    'holiday_impact(date)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
  revoke all on function public.set_tracker_state(uuid, public.tracker_state, text)
    from public, anon, authenticated;
  grant execute on function public.set_tracker_state(uuid, public.tracker_state, text)
    to service_role;
end;
$$;
