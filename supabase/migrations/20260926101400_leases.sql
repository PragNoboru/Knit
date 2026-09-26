-- PRD 7.3, 9.1: job mutual exclusion. A job takes a lease for ttl seconds; a second call while
-- the lease is valid gets null and exits at once. An expired lease can be taken over, so a
-- job that crashed never blocks the next call for longer than its ttl. Service role only.

-- Returns the new holder id, or null when another holder's lease is still valid.
create function public.acquire_lease(p_job text, p_ttl_seconds integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_holder uuid;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_job is null or btrim(p_job) = '' or p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'invalid_lease_request' using errcode = '22023';
  end if;

  insert into job_leases (job, holder, expires_at)
  values (p_job, gen_random_uuid(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (job) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where job_leases.expires_at <= now()
  returning holder into v_holder;

  return v_holder;
end;
$$;

-- Releases the lease if this holder still has it. Returns whether it did.
create function public.release_lease(p_job text, p_holder uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  delete from job_leases where job = p_job and holder = p_holder;
  return found;
end;
$$;

revoke all on function public.acquire_lease(text, integer) from public, anon, authenticated;
revoke all on function public.release_lease(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_lease(text, integer) to service_role;
grant execute on function public.release_lease(text, uuid) to service_role;
