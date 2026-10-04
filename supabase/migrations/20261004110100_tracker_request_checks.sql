-- PRD N87, 9.1, 9.2: at most 5 sheet checks per person in any 10 minutes. The server action
-- requestTracker calls claim_tracker_check with the person's own session, after the checks it
-- makes without Google (those do not count) and before it reads Google. A person calling it
-- directly only uses up their own checks.

create table public.tracker_request_checks (
  id bigserial primary key,
  user_id uuid not null references public.app_users (id) on delete cascade,
  checked_at timestamptz not null default now()
);

create index tracker_request_checks_by_user
  on public.tracker_request_checks (user_id, checked_at);

-- 9.2: no access for authenticated; written only by claim_tracker_check.
alter table public.tracker_request_checks enable row level security;
revoke all on public.tracker_request_checks from anon, authenticated;
revoke all on sequence public.tracker_request_checks_id_seq from anon, authenticated;

-- Records a check for the caller and returns true, or false when the caller already made 5 in
-- the last 10 minutes. A per-person advisory lock makes two checks at once count one after the
-- other. The caller's checks older than a day are dropped as it goes.
create function public.claim_tracker_check()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid constant uuid := auth.uid();
begin
  if v_uid is null or not knit_is_active_user() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tracker_check:' || v_uid::text, 0));
  delete from tracker_request_checks
  where user_id = v_uid and checked_at < now() - interval '1 day';
  if (select count(*) from tracker_request_checks
      where user_id = v_uid and checked_at > now() - interval '10 minutes') >= 5 then
    return false;
  end if;
  insert into tracker_request_checks (user_id) values (v_uid);
  return true;
end;
$$;

revoke all on function public.claim_tracker_check() from public, anon;
grant execute on function public.claim_tracker_check() to authenticated;
