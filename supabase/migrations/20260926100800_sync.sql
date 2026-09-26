-- PRD 8.1, 10: tables the sync engine and the jobs work with.

-- 10.4: write-backs waiting to reach the sheet. Payload: {status_value|null, completed_on|null};
-- the Knit Note is rendered by the push job at write time (6.9).
create table public.outbox (
  id bigserial primary key,
  task_id uuid not null references public.tasks (id),
  tracker_id uuid not null references public.trackers (id),
  payload jsonb not null,
  state public.outbox_state not null default 'pending',
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create index outbox_state_next_attempt_at_idx on public.outbox (state, next_attempt_at);
create index outbox_open_by_task_idx on public.outbox (task_id) where state in ('pending', 'held');

-- 15: every status change has an event with actor and origin.
create table public.events (
  id bigserial primary key,
  task_id uuid references public.tasks (id),
  task_day_id bigint references public.task_days (id),
  tracker_id uuid references public.trackers (id),
  actor_user_id uuid references public.app_users (id),   -- null for system and source changes
  origin public.change_origin not null,
  field text not null,
  old_value text,
  new_value text,
  reason text,
  at timestamptz not null default now()
);

create index events_task_id_at_idx on public.events (task_id, at);

-- 19: one row per job call, shown on Sync health.
create table public.sync_runs (
  id bigserial primary key,
  job text not null,
  tracker_id uuid references public.trackers (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  stats jsonb,
  error text
);

create index sync_runs_started_at_idx on public.sync_runs (started_at desc);

-- 10.5: progress of each day's close.
create table public.day_closures (
  day date primary key,
  state text not null check (state in ('running', 'closed', 'failed')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  stats jsonb,
  error text
);

-- 8.1, 14: Needs Attention items. Kinds: unmapped_status, bad_date, duplicate_knit_id,
-- unknown_owner, conflict, missing_header, missing_knit_id_column, write_blocked,
-- past_date_added, row_not_found, formula_column, member_report, calendar_ending.
create table public.attention_items (
  id bigserial primary key,
  tracker_id uuid references public.trackers (id),
  task_id uuid references public.tasks (id),
  kind text not null,
  dedupe_key text not null,          -- for example 'unmapped_status:copy ready'
  detail jsonb not null default '{}',
  state text not null default 'open' check (state in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- One open item per tracker and dedupe key (6.7, 6.8: one item per distinct name or word,
-- never per row). NULLS NOT DISTINCT also dedupes items that belong to no tracker.
create unique index attention_items_open_dedupe_idx
  on public.attention_items (tracker_id, dedupe_key) nulls not distinct
  where state = 'open';

-- 7.3: job mutual exclusion.
create table public.job_leases (
  job text primary key,
  holder uuid not null,
  expires_at timestamptz not null
);
