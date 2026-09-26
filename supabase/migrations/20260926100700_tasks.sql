-- PRD 2, 8.1: a task is one data row of a tracker. Its id is the Knit ID written into the
-- sheet (N7), so the app generates it; there is no default.
create table public.tasks (
  id uuid primary key,
  tracker_id uuid not null references public.trackers (id),
  source_ref text,
  row_hint int,
  title text not null,
  subtitle text,
  details jsonb not null default '{}',
  planned_raw text,
  date_kind public.date_kind,
  planned_start date,
  planned_end date,
  due_date date,
  critical boolean not null default false,
  owner_raw text,
  -- The task's current status. `not_done` belongs to locked task-days only (PRD 6.1).
  status public.knit_status not null default 'yet_to_start'
    check (status <> 'not_done'),
  status_reason text,
  source_status_raw text,
  completed_on date,
  history_only boolean not null default false,
  removed_at_source timestamptz,
  -- 10.3: last values read from or written to mapped columns.
  source_snapshot jsonb,
  hub_changed_at timestamptz,
  source_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_tracker_id_idx on public.tasks (tracker_id);
create index tasks_due_date_idx on public.tasks (due_date);

-- PRD 6.7: which users a task is assigned to (from the owner column).
create table public.task_assignees (
  task_id uuid references public.tasks (id) on delete cascade,
  user_id uuid references public.app_users (id),
  primary key (task_id, user_id)
);

create index task_assignees_user_id_idx on public.task_assignees (user_id);

-- PRD 2, 6.4: a task's appearance on one date. A task missed twice and done on the third day
-- has three task-days.
create table public.task_days (
  id bigserial primary key,
  task_id uuid not null references public.tasks (id),
  day date not null,
  status public.knit_status not null,
  -- 6.4: the status a task-day had when its day closed unfinished; the spillover carries it.
  carried_status public.knit_status
    check (carried_status is null or carried_status in ('yet_to_start', 'in_progress', 'blocked')),
  spill_index int not null default 0 check (spill_index >= 0),
  origin text not null check (origin in ('planned', 'spillover', 'backlog', 'completion')),
  reason text,
  status_changed_on date,
  locked boolean not null default false,
  locked_at timestamptz,
  unique (task_id, day),
  -- 6.1: Not Done exists only on locked task-days.
  constraint task_days_not_done_only_when_locked check (status <> 'not_done' or locked),
  constraint task_days_locked_at_matches_locked check (locked = (locked_at is not null))
);

create index task_days_day_idx on public.task_days (day);
