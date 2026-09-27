-- PRD 10.5 steps 2 and 3, 15, invariant 8: the close's forced pull remembers its progress.
--
-- Day D closes only after a forced pull of every active tracker (10.5 step 2), so a Done
-- entered in a sheet before midnight always counts for D (D10). When the pulls do not all fit
-- in one call's time budget (a 1,000-row tracker may take 20 s, 15), or one tracker's pull
-- fails, the next call must not start them all again, or D could never close. Each tracker
-- pulled for D is recorded here; any pull made after D ended has read everything written on
-- D, so later calls pull only the trackers still missing.

alter table public.day_closures
  add column pulled_trackers uuid[] not null default '{}';

comment on column public.day_closures.pulled_trackers is
  'Trackers the close of this day has already force-pulled (PRD 10.5 step 2).';

-- The trackers already force-pulled for D, over every call that worked on D.
create or replace function public.close_pulled_trackers(p_day date)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((select pulled_trackers from day_closures where day = p_day), '{}');
end;
$$;

-- Records that the close of D force-pulled a tracker. Idempotent.
create or replace function public.record_close_pull(p_day date, p_tracker_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into day_closures (day, state, pulled_trackers)
  values (p_day, 'running', array[p_tracker_id])
  on conflict (day) do update
    set pulled_trackers = day_closures.pulled_trackers || p_tracker_id
    where not (p_tracker_id = any (day_closures.pulled_trackers));
end;
$$;

revoke all on function public.close_pulled_trackers(date) from public, anon, authenticated;
revoke all on function public.record_close_pull(date, uuid) from public, anon, authenticated;
grant execute on function public.close_pulled_trackers(date) to service_role;
grant execute on function public.record_close_pull(date, uuid) to service_role;
