-- PRD 8.1, 10.1: files seen in the Knit folder. Only native Google Sheets can become trackers.
create table public.drive_files (
  file_id text primary key,
  name text not null,
  mime_type text not null,
  modified_time timestamptz,
  state public.drive_file_state not null default 'new',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- PRD 2, 8.1, 8.2: a tracker is one tab (identified by sheet gid, never by name) of one sheet.
-- `config` holds the registry (8.2), validated with zod by the app before it is saved.
create table public.trackers (
  id uuid primary key default gen_random_uuid(),
  file_id text not null references public.drive_files (file_id),
  sheet_gid bigint not null,
  tab_name text not null,
  name text not null,
  -- PRD 12.2: one colour per tracker from the 8-colour palette.
  color text not null
    check (color in ('indigo', 'teal', 'amber', 'rose', 'violet', 'emerald', 'sky', 'orange')),
  owner_user_id uuid references public.app_users (id),
  state public.tracker_state not null default 'draft',
  pause_reason text,
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  -- D1, 6.11: rows planned before this date are history only.
  go_live_date date not null,
  -- 10.2 step 7: bumped on every hub-side status change, so a pull plan computed before the
  -- change is detected as stale and recomputed.
  state_version bigint not null default 0,
  last_pull_at timestamptz,
  last_source_modified_time timestamptz,
  created_at timestamptz not null default now(),
  unique (file_id, sheet_gid)
);
