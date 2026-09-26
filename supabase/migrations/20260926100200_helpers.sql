-- Small helpers used by the tables, policies and RPC functions that follow.

-- CLAUDE.md invariant 1, PRD 9.1: the business date is the date in Asia/Kolkata. Every date
-- decision in SQL goes through knit_today().
--
-- Test clock (PRD 14 and 17: time is always injected): integration tests freeze "today" for
-- one transaction with `select set_config('knit.today', 'yyyy-mm-dd', true)`. Only a direct
-- database session can do that; the Data API has no way to run SET.
create function public.knit_today()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(current_setting('knit.today', true), '')::date,
    (now() at time zone 'Asia/Kolkata')::date
  )
$$;

-- PRD 6.7, 6.8, 8.2: owner names, headers and status words are compared after trimming,
-- lowercasing and collapsing whitespace (non-breaking spaces included, as sheets use them).
-- lib/domain applies the same rule in TypeScript.
create function public.knit_normalise(value text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select lower(btrim(regexp_replace(value, '[[:space:] ]+', ' ', 'g')))
$$;

-- PRD 6.9: dates in notes and reasons read like "Mon 5 Oct" (EEE d MMM).
create function public.knit_format_day(d date)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select to_char(d, 'Dy FMDD Mon')
$$;

-- PRD 9.1: every RPC checks its caller. The caller is read from the JWT that the Data API
-- (PostgREST) sets for each request. A session with no JWT at all is a direct database
-- session (migrations, the SQL editor), open only to people with the database password, so
-- it is trusted like the service role.
create function public.knit_is_trusted()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(auth.jwt() ->> 'role', 'direct') in ('service_role', 'direct')
$$;

revoke all on function public.knit_today() from public, anon;
revoke all on function public.knit_normalise(text) from public, anon;
revoke all on function public.knit_format_day(date) from public, anon;
revoke all on function public.knit_is_trusted() from public, anon;
grant execute on function public.knit_today() to authenticated, service_role;
grant execute on function public.knit_normalise(text) to authenticated, service_role;
grant execute on function public.knit_format_day(date) to authenticated, service_role;
grant execute on function public.knit_is_trusted() to authenticated, service_role;
