-- PRD 12.3, 12.7, N18(a), N18(b): day_view again, with two corrections.
--
-- * earlyDone (6.5: later task-days marked done on the day, tagged "early") is for Today only.
--   N18(a): a past day shows only its own task-days, so it no longer lists task-days of later
--   dates that were finished early on it (they were also editable there before the close).
-- * upcoming (12.7 "Nothing is planned for today": the next three tasks to pull forward)
--   leaves out tasks already shown under Ongoing on the day (an active window or a started
--   open-ended task), so a task shows once per page (N18 b) and the three offers are three
--   other tasks. lib/domain/day-view.ts applies the same rule to every notice list.
--
-- Everything else is exactly as in 20260927100000_screens.sql.

create or replace function public.day_view(p_day date default null)
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
    -- 6.5: later task-days marked done today ("early"). Today only (N18 a).
    'earlyDone', case when v_day = v_today then coalesce((
      select jsonb_agg(knit_task_card(k, t, d))
      from task_days d
      join tasks k on k.id = d.task_id
      join trackers t on t.id = k.tracker_id
      where d.day > v_day and d.status = 'done' and d.status_changed_on = v_day
        and knit_can_see(k.id, false)), '[]'::jsonb) else '[]'::jsonb end,
    -- 12.7 "Nothing is planned for today": the next three upcoming tasks, to pull forward,
    -- leaving out tasks already under Ongoing today (N18 b).
    'upcoming', case when v_day = v_today then coalesce((
      select jsonb_agg(up.card order by up.day, up.critical desc, up.title)
      from (
        select knit_task_card(k, t, d) as card, d.day, k.critical, k.title
        from task_days d
        join tasks k on k.id = d.task_id
        join trackers t on t.id = k.tracker_id
        where d.day > v_day and not d.locked and d.status in ('yet_to_start', 'blocked')
          and knit_can_see(k.id, false)
          -- The same test as 'ongoing' above (coalesce: a missing date is not ongoing).
          and not coalesce(
            k.removed_at_source is null and not k.history_only
            and k.status not in ('done', 'cancelled')
            and (
              (k.date_kind = 'window' and k.planned_start <= v_day and k.due_date > v_day)
              or (k.date_kind = 'open' and k.planned_start <= v_day)
            ), false)
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

revoke all on function public.day_view(date) from public, anon;
grant execute on function public.day_view(date) to authenticated;
