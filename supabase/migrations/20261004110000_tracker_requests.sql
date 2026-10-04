-- PRD N83, N85, N86, 8.1, 9.2: the sheets people send the admin from the Guide ("Send a sheet
-- to the admin"). A row is written only by record_tracker_request (service role, after the
-- server's checks of N84), and changes only through admin_dismiss_tracker_request and the
-- resolve_tracker_requests trigger, so authenticated callers may only read.

create table public.tracker_requests (
  id bigserial primary key,
  requested_by uuid not null references public.app_users (id),
  file_id text not null references public.drive_files (file_id),
  -- The Tasks tab that was checked.
  sheet_gid bigint not null,
  -- The sheet's name as Drive listed it when the request was sent (N85).
  file_name text not null,
  -- A version id of lib/domain/standard-template.ts (knit-standard-v1 or -v2).
  template_id text not null,
  task_count int not null check (task_count > 0),
  -- Rows naming people Knit does not know (N84: they do not block a request).
  unknown_names int not null default 0 check (unknown_names >= 0),
  -- N87: optional, at most 280 characters.
  note text check (note is null or char_length(note) between 1 and 280),
  state text not null default 'open' check (state in ('open', 'connected', 'dismissed')),
  -- N86, D2: one line, at most 140 characters, only on a dismissed request.
  dismiss_reason text
    check (dismiss_reason is null or char_length(dismiss_reason) between 1 and 140),
  -- N86: the tracker that connected the file.
  tracker_id uuid references public.trackers (id),
  resolved_by uuid references public.app_users (id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint tracker_requests_resolved_when_answered check ((state = 'open') = (resolved_at is null)),
  constraint tracker_requests_reason_when_dismissed check ((state = 'dismissed') = (dismiss_reason is not null)),
  constraint tracker_requests_tracker_when_connected check ((state = 'connected') = (tracker_id is not null))
);

-- N87: one open request per file, whoever sent it.
create unique index tracker_requests_one_open_per_file
  on public.tracker_requests (file_id) where state = 'open';

-- N85: the Guide lists a person's own last 10 requests, newest first.
create index tracker_requests_by_user
  on public.tracker_requests (requested_by, created_at desc);

-- 9.2: the admin reads every request; an active person reads their own. No insert, update or
-- delete for authenticated: writes only through the functions of the next migrations.
alter table public.tracker_requests enable row level security;
revoke all on public.tracker_requests from anon, authenticated;
revoke all on sequence public.tracker_requests_id_seq from anon, authenticated;
grant select on public.tracker_requests to authenticated;

create policy tracker_requests_select on public.tracker_requests
  for select to authenticated
  using (
    (requested_by = (select auth.uid()) and (select public.knit_is_active_user()))
    or (select public.knit_is_admin())
  );
