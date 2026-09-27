-- PRD 12, 13: read functions for the screens, and the two small writes they need (Sync now,
-- Report an issue). Each checks its caller: an active Knit user sees the tasks assigned to
-- them. Today, Day and Calendar are always the caller's own tasks (N3); only All Tasks has
-- the admin's Everyone toggle (12.5). The functions are security definer so a member also
-- gets, for their own tasks only, what 9.2 keeps from them directly: the sheet link (12.3)
-- and whether a write-back is still waiting (the Syncing pill). How rows are grouped and
-- coloured is decided in lib/domain, not here and not in React (invariant 9).

-- The Syncing pill reads the newest write-back of a task.
create index outbox_task_id_id_idx on public.outbox (task_id, id desc);

-- The caller may see this task: it is assigned to them, or the admin asks for everyone's.
create function public.knit_can_see(p_task_id uuid, p_everyone boolean)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select (p_everyone and knit_is_admin())
      or exists (select 1 from task_assignees a where a.task_id = p_task_id and a.user_id = auth.uid())
$$;

-- One task (and optionally one of its task-days) as the screens show it.
create function public.knit_task_card(k public.tasks, t public.trackers, d public.task_days)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'taskId', k.id, 'title', k.title, 'subtitle', k.subtitle, 'critical', k.critical,
    'dueDate', k.due_date, 'plannedStart', k.planned_start, 'plannedEnd', k.planned_end,
    'plannedRaw', k.planned_raw, 'dateKind', k.date_kind, 'taskStatus', k.status,
    'taskReason', k.status_reason, 'completedOn', k.completed_on, 'sourceRef', k.source_ref,
    'rowHint', k.row_hint, 'historyOnly', k.history_only,
    'removed', k.removed_at_source is not null,
    'tracker', jsonb_build_object(
      'id', t.id, 'name', t.name, 'color', t.color, 'fileId', t.file_id, 'gid', t.sheet_gid),
    'taskDay', case when d.id is null then null else jsonb_build_object(
      'id', d.id, 'day', d.day, 'status', d.status, 'spillIndex', d.spill_index,
      'reason', d.reason, 'locked', d.locked, 'carriedStatus', d.carried_status,
      'statusChangedOn', d.status_changed_on, 'origin', d.origin) end,
    -- 12.3: the state of the newest status write-back (pending, held or failed; null once it
    -- is done). Knit Note refreshes (N17) are not changes made in Knit and do not count.
    'sync', (
      select case when o.state in ('pending', 'held', 'failed') then o.state::text end
      from outbox o
      where o.task_id = k.id and not coalesce((o.payload ->> 'note_only')::boolean, false)
      order by o.id desc
      limit 1),
    'spillCount', (select coalesce(max(x.spill_index), 0) from task_days x where x.task_id = k.id),
    -- What set_task_status would accept: an open task-day today or later, or an unfinished
    -- open-ended task (N9). Waiting for yesterday's close (N10), removed rows (N11) and
    -- history-only rows (6.11) cannot change.
    'editable', k.removed_at_source is null and not k.history_only and (
      exists (select 1 from task_days x where x.task_id = k.id and not x.locked and x.day >= knit_today())
      or (k.date_kind = 'open' and k.status not in ('done', 'cancelled')))
  )
$$;

-- 12.3, 12.4, 12.7: everything the Today and Day views need for day p_day (null: today).
create function public.day_view(p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today constant date := knit_today();
  v_day constant date := coalesce(p_day, v_today);
  v_next date;
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from calendar_days where day = v_day) then
    raise exception 'calendar_not_covered' using errcode = '22023';
  end if;
  begin
    v_next := next_working_day(v_day);
  exception when others then
    v_next := null;
  end;

  return jsonb_build_object(
    'day', v_day,
    'today', v_today,
    'isWorking', (select is_working from calendar_days where day = v_day),
    'offReason', (select reason from calendar_days where day = v_day),
    'nextWorkingDay', v_next,
    'isAdmin', knit_is_admin(),
    -- 12.7: a member with no tasks at all, or an admin with no connected tracker yet.
    'hasTasks', exists (
      select 1 from task_assignees a join tasks k on k.id = a.task_id
      where a.user_id = auth.uid() and k.removed_at_source is null),
    'hasTrackers', exists (select 1 from trackers where state <> 'draft'),
    'adminContact', (
      select jsonb_build_object('name', u.name, 'email', u.email)
      from app_users u where u.role = 'admin' and u.is_active order by u.created_at limit 1),
    -- The caller's task-days on the day.
    'rows', coalesce((
      select jsonb_agg(knit_task_card(k, t, d))
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day = v_day and knit_can_see(k.id, false)), '[]'::jsonb),
    -- 6.3.3, N4: unfinished windows from their start until their due day, and unfinished
    -- open-ended tasks from their start. Today and later only: for a past day Knit knows the
    -- task-days, not what was ongoing then.
    'ongoing', case when v_day >= v_today then coalesce((
      select jsonb_agg(knit_task_card(k, t, null::task_days))
      from tasks k
      join trackers t on t.id = k.tracker_id
      where knit_can_see(k.id, false)
        and k.removed_at_source is null and not k.history_only
        and k.status not in ('done', 'cancelled')
        and (
          (k.date_kind = 'window' and k.planned_start <= v_day and k.due_date > v_day)
          or (k.date_kind = 'open' and k.planned_start <= v_day)
        )), '[]'::jsonb) else '[]'::jsonb end,
    -- 12.3, D3: tasks due after today that are In progress. Today only.
    'pulledForward', case when v_day = v_today then coalesce((
      select jsonb_agg(knit_task_card(k, t, d))
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day > v_day and d.status = 'in_progress' and not d.locked
        and knit_can_see(k.id, false)), '[]'::jsonb) else '[]'::jsonb end,
    -- 6.5: later task-days marked done on this day ("early").
    'earlyDone', case when v_day <= v_today then coalesce((
      select jsonb_agg(knit_task_card(k, t, d))
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day > v_day and d.status = 'done' and d.status_changed_on = v_day
        and knit_can_see(k.id, false)), '[]'::jsonb) else '[]'::jsonb end,
    -- 12.7 "Nothing is planned for today": the next three upcoming tasks, to pull forward.
    'upcoming', case when v_day = v_today then coalesce((
      select jsonb_agg(up.card order by up.day, up.critical desc, up.title)
      from (
        select knit_task_card(k, t, d) as card, d.day, k.critical, k.title
        from task_days d
        join tasks k on k.id = d.task_id
        join trackers t on t.id = k.tracker_id
        where d.day > v_day and not d.locked and d.status in ('yet_to_start', 'blocked')
          and knit_can_see(k.id, false)
        order by d.day, k.critical desc, k.title
        limit 3
      ) up), '[]'::jsonb) else '[]'::jsonb end,
    -- 12.7 "All clear": the next working day's tasks, shown collapsed.
    'nextDayRows', case when v_day = v_today and v_next is not null then coalesce((
      select jsonb_agg(knit_task_card(k, t, d))
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day = v_next and knit_can_see(k.id, false)), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- 12.4: one entry per day of the month holding p_month, with the counts behind its colour.
create function public.month_view(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_first constant date := date_trunc('month', p_month)::date;
  v_last constant date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'today', knit_today(),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', c.day, 'isWorking', c.is_working, 'reason', c.reason,
        'total', coalesce(s.total, 0), 'finished', coalesce(s.finished, 0),
        'notDone', coalesce(s.not_done, 0), 'open', coalesce(s.open, 0),
        'locked', coalesce(s.locked, false)) order by c.day)
      from calendar_days c
      left join lateral (
        select count(*) as total,
               count(*) filter (where d.status in ('done', 'cancelled')) as finished,
               count(*) filter (where d.status = 'not_done') as not_done,
               count(*) filter (where d.status in ('yet_to_start', 'in_progress', 'blocked')) as open,
               bool_or(d.locked) as locked
        from task_days d
        join task_assignees a on a.task_id = d.task_id and a.user_id = auth.uid()
        where d.day = c.day
      ) s on true
      where c.day between v_first and v_last), '[]'::jsonb));
end;
$$;

-- 12.5: All Tasks, 50 per page, with filters and a title search.
create function public.task_list(p_query jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_everyone constant boolean := coalesce((p_query ->> 'everyone')::boolean, false);
  v_page constant integer := greatest(coalesce((p_query ->> 'page')::integer, 1), 1);
  v_size constant integer := 50;
  v_search constant text := nullif(btrim(p_query ->> 'search'), '');
  v_from constant date := (p_query ->> 'from')::date;
  v_to constant date := (p_query ->> 'to')::date;
  v_trackers uuid[];
  v_statuses knit_status[];
  v_pattern text;
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p_query -> 'trackerIds', '[]')) x)
    into v_trackers;
  select array(select (x #>> '{}')::knit_status from jsonb_array_elements(coalesce(p_query -> 'statuses', '[]')) x)
    into v_statuses;
  -- The search is literal text: escape the LIKE wildcards.
  v_pattern := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return (
    with matching as (
      select k.id, k.due_date, t.name as tracker_name, k.title
      from tasks k
      join trackers t on t.id = k.tracker_id
      where knit_can_see(k.id, v_everyone)
        and (cardinality(v_trackers) = 0 or k.tracker_id = any (v_trackers))
        and (cardinality(v_statuses) = 0 or k.status = any (v_statuses))
        and (v_search is null or k.title ilike v_pattern)
        and (v_from is null or coalesce(k.due_date, k.planned_start) >= v_from)
        and (v_to is null or coalesce(k.due_date, k.planned_start) <= v_to)
    ),
    page as (
      select id, due_date, tracker_name, title from matching
      order by due_date nulls last, tracker_name, title, id
      offset (v_page - 1) * v_size limit v_size
    )
    select jsonb_build_object(
      'total', (select count(*) from matching),
      'page', v_page,
      'pageSize', v_size,
      'rows', coalesce((
        select jsonb_agg(knit_task_card(k, t, null::task_days)
                         order by p.due_date nulls last, p.tracker_name, p.title, p.id)
        from page p
        join tasks k on k.id = p.id
        join trackers t on t.id = k.tracker_id), '[]'::jsonb)
    )
  );
end;
$$;

-- 12.6: the task drawer: details, every task-day, and every event with who made it.
create function public.task_detail(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not knit_is_active_user() or not knit_can_see(p_task_id, true) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'card', knit_task_card(k, t, null::task_days),
      'details', k.details,
      -- Detail columns in the order the tracker's setup chose (8.2 detailColumns).
      'detailOrder', coalesce(t.config -> 'detailColumns', '[]'::jsonb),
      'ownerRaw', k.owner_raw,
      'taskDays', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.id, 'day', d.day, 'status', d.status, 'spillIndex', d.spill_index,
          'reason', d.reason, 'locked', d.locked, 'carriedStatus', d.carried_status,
          'statusChangedOn', d.status_changed_on, 'origin', d.origin) order by d.day)
        from task_days d where d.task_id = k.id), '[]'::jsonb),
      'events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', e.id, 'at', e.at, 'origin', e.origin, 'field', e.field,
          'oldValue', e.old_value, 'newValue', e.new_value, 'reason', e.reason,
          'actor', u.name) order by e.at, e.id)
        from events e left join app_users u on u.id = e.actor_user_id
        where e.task_id = k.id), '[]'::jsonb)
    )
    from tasks k join trackers t on t.id = k.tracker_id
    where k.id = p_task_id
  );
end;
$$;

-- 12.3: the sync state of the given tasks, polled every 3 s while any is pending.
create function public.task_sync_status(p_task_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_object_agg(k.id, knit_task_card(k, t, null::task_days) -> 'sync')
    from tasks k join trackers t on t.id = k.tracker_id
    where k.id = any (p_task_ids) and knit_can_see(k.id, true)), '{}'::jsonb);
end;
$$;

-- 12.3, 10.5 step 4: the facts behind the Today banners. Times are decided in lib/domain.
create function public.app_banners()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today constant date := knit_today();
  v_admin constant boolean := knit_is_admin();
  v_next date;
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  begin
    v_next := next_working_day(v_today);
  exception when others then
    v_next := null;
  end;
  return jsonb_build_object(
    'today', v_today,
    'isAdmin', v_admin,
    -- 10.5 step 4: yesterday needs a close once any connected tracker was live on it.
    'yesterdayNotClosed', v_admin
      and coalesce((select min(go_live_date) from trackers where state <> 'draft') <= v_today - 1, false)
      and not exists (select 1 from day_closures where day = v_today - 1 and state = 'closed'),
    -- 12.3, 14: paused trackers the caller has tasks in (the admin: all of them).
    'paused', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'reason', t.pause_reason, 'lastPullAt', t.last_pull_at)
        order by t.name)
      from trackers t
      where t.state = 'paused'
        and (v_admin or exists (
          select 1 from tasks k join task_assignees a on a.task_id = k.id
          where k.tracker_id = t.id and a.user_id = auth.uid()))), '[]'::jsonb),
    -- D4: the caller's task-days on today that are still open.
    'openToday', (
      select count(*)
      from task_days d join task_assignees a on a.task_id = d.task_id
      where d.day = v_today and a.user_id = auth.uid()
        and d.status in ('yet_to_start', 'in_progress', 'blocked')),
    'nextWorkingDay', v_next
  );
end;
$$;

-- 7.3, 13: Sync now, at most once per 30 s per user.
create table public.sync_now_requests (
  user_id uuid primary key references public.app_users (id) on delete cascade,
  requested_at timestamptz not null
);
alter table public.sync_now_requests enable row level security;
revoke all on public.sync_now_requests from anon, authenticated;

-- Records the request and returns the trackers to pull (the caller's; every active tracker
-- for the admin), or null when the caller asked less than 30 s ago.
create function public.request_sync_now()
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid constant uuid := auth.uid();
begin
  if v_uid is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into sync_now_requests (user_id, requested_at) values (v_uid, now())
  on conflict (user_id) do update set requested_at = now()
    where sync_now_requests.requested_at <= now() - interval '30 seconds';
  if not found then
    return null;
  end if;
  return array(
    select t.id from trackers t
    where t.state = 'active'
      and (knit_is_admin() or exists (
        select 1 from tasks k join task_assignees a on a.task_id = k.id
        where k.tracker_id = t.id and a.user_id = v_uid))
    order by t.name);
end;
$$;

-- 12.6, 9.2: a member reports a problem with one of their task-days (attention member_report).
-- Reporting the same task-day again replaces the open report's text.
create function public.report_issue(p_task_day_id bigint, p_text text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text constant text := nullif(btrim(coalesce(p_text, '')), '');
  v_task uuid;
  v_tracker uuid;
begin
  if auth.uid() is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_text is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if char_length(v_text) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  select d.task_id, k.tracker_id into v_task, v_tracker
  from task_days d join tasks k on k.id = d.task_id
  where d.id = p_task_day_id;
  if v_task is null or not knit_can_see(v_task, false) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
  values (v_tracker, v_task, 'member_report',
          'member_report:' || p_task_day_id || ':' || auth.uid(),
          jsonb_build_object('taskDayId', p_task_day_id, 'text', v_text, 'userId', auth.uid()))
  on conflict (tracker_id, dedupe_key) where state = 'open'
    do update set detail = excluded.detail, created_at = now();
end;
$$;

do $$
declare
  fn text;
begin
  -- Helpers: called only from the functions below, which run as their owner.
  foreach fn in array array[
    'knit_can_see(uuid, boolean)',
    'knit_task_card(public.tasks, public.trackers, public.task_days)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
  end loop;
  foreach fn in array array[
    'day_view(date)',
    'month_view(date)',
    'task_list(jsonb)',
    'task_detail(uuid)',
    'task_sync_status(uuid[])',
    'app_banners()',
    'request_sync_now()',
    'report_issue(bigint, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end;
$$;
