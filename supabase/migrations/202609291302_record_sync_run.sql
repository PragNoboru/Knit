-- PRD 19 (sync_runs for every job call, with counts and errors; Sync health shows them), 12.8
-- (Sync health: the last 50 runs), 7.3 (jobs and their leases).
--
-- Pull, discover and structure calls write their rows themselves (start_sync_run and
-- finish_sync_run). The push runs every minute and the close every 15 minutes, and most of
-- their calls find nothing to do; a row for each of those would push every other run out of
-- the 50 Sync health shows within the hour. So lib/jobs/cron.ts records a push or close call
-- that did work, failed, or was skipped because another call held the lease, once it knows,
-- with the time it started. record_sync_run writes that finished row in one go.

create function public.record_sync_run(
  p_job text,
  p_started_at timestamptz,
  p_ok boolean,
  p_stats jsonb,
  p_error text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into sync_runs (job, started_at, finished_at, ok, stats, error)
  values (p_job, coalesce(p_started_at, now()), now(), p_ok, coalesce(p_stats, '{}'::jsonb),
          p_error)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_sync_run(text, timestamptz, boolean, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.record_sync_run(text, timestamptz, boolean, jsonb, text)
  to service_role;
