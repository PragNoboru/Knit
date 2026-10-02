-- PRD N73, N75 (12.3, 12.5, 12.6): the screens show a task's Owner, the person who checks it
-- (N72), when its tracker maps a checking owner column (8.2 columns.checker). The pull keeps
-- the checker cell's text in tasks.details under that column's header (N73), so no column is
-- added to tasks; this replaces knit_task_card, unchanged otherwise (20260927100000_screens),
-- to add one field:
--   checker: null when the tracker maps no checking owner column; else its header (the drawer
--   leaves that detail out, since it shows the Owner itself) and the cell's text, or null when
--   the cell is blank.
-- Every screen function builds its rows with knit_task_card, so Today, Day, Calendar, All
-- Tasks and the drawer all get it. Older app code ignores the extra field.
create or replace function public.knit_task_card(k public.tasks, t public.trackers, d public.task_days)
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
    -- N73, N75: the checking owner, read from the details under the checker column's header.
    'checker', case when t.config #>> '{columns,checker}' is null then null else jsonb_build_object(
      'header', t.config #>> '{columns,checker}',
      'raw', nullif(btrim(k.details ->> (t.config #>> '{columns,checker}')), '')) end,
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

-- A helper, as before: only the screen functions, which run as their owner, call it.
-- (create or replace keeps its grants; this states them again.)
revoke all on function public.knit_task_card(public.tasks, public.trackers, public.task_days)
  from public, anon, authenticated;
