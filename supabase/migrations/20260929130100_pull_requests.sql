-- PRD 11 ("Editing a live tracker's mapping: saving runs a structure check and a forced
-- pull"), N19(d) (Map status and Link owner save, then pull again), 12.8 (a holiday change
-- recomputes due dates through a pull), 10.2 step 1 (a pull skips a sheet whose modifiedTime
-- has not changed, unless forced).
--
-- A change to what a pull reads besides the sheet (a tracker's config, the people aliases,
-- the working-day calendar) must reach the tasks even when the forced pull the admin's save
-- starts cannot run because another pull holds the lease, and even when a pull that loaded the
-- old config is still running and then records the sheet's modifiedTime. So the change is
-- recorded here, in the same transaction, as a pull the tracker is owed:
--   * pull_requested goes up by one on every such change;
--   * pull_served is the highest pull_requested a finished pull had read before it loaded its
--     inputs (mark_pull_served, called by lib/sync/pull.ts after apply_pull_plan).
-- While pull_served < pull_requested the pull never skips the tracker. A pull that loaded its
-- inputs before the change reports an older number, so it cannot clear the request.

alter table public.trackers
  add column pull_requested bigint not null default 0,
  add column pull_served bigint not null default 0;

comment on column public.trackers.pull_requested is
  'Bumped by every change a pull reads besides the sheet (config, aliases, calendar).';
comment on column public.trackers.pull_served is
  'The highest pull_requested a finished pull read before loading its inputs.';

-- A tracker's own config changed (Edit mapping, Map status, activation).
create function public.knit_request_pull_on_config()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.pull_requested := old.pull_requested + 1;
  return new;
end;
$$;

create trigger trackers_request_pull_on_config
  before update of config on public.trackers
  for each row
  when (old.config is distinct from new.config)
  execute function public.knit_request_pull_on_config();

-- The aliases (6.7) or the calendar (6.2: holidays refresh it) changed: every tracker that
-- syncs is owed a pull. Security definer: the admin's own session saves holidays, and the
-- trackers table is written only by the server (9.2).
create function public.knit_request_pull_everywhere()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update trackers set pull_requested = pull_requested + 1
  where state in ('active', 'paused');
  return null;
end;
$$;

create trigger people_aliases_request_pull
  after insert or update or delete on public.people_aliases
  for each statement execute function public.knit_request_pull_everywhere();

create trigger calendar_days_request_pull
  after insert or update or delete on public.calendar_days
  for each statement execute function public.knit_request_pull_everywhere();

-- What the pull reads before it loads the trackers (lib/sync/pull.ts pullAll).
create function public.pull_requests(p_ids uuid[] default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_object_agg(id::text, jsonb_build_object(
      'requested', pull_requested, 'served', pull_served))
    from trackers
    where p_ids is null or id = any (p_ids)), '{}'::jsonb);
end;
$$;

-- After a pull applied its plan: the requests it had read are served. Never goes back.
create function public.mark_pull_served(p_tracker_id uuid, p_requested bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update trackers set pull_served = greatest(pull_served, p_requested)
  where id = p_tracker_id;
end;
$$;

revoke all on function public.knit_request_pull_on_config() from public, anon, authenticated;
revoke all on function public.knit_request_pull_everywhere() from public, anon, authenticated;
revoke all on function public.pull_requests(uuid[]) from public, anon, authenticated;
revoke all on function public.mark_pull_served(uuid, bigint) from public, anon, authenticated;
grant execute on function public.pull_requests(uuid[]) to service_role;
grant execute on function public.mark_pull_served(uuid, bigint) to service_role;
