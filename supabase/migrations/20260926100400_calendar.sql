-- PRD 6.2, D11, N2: the working-day calendar.

create table public.holidays (
  day date primary key,
  name text not null check (btrim(name) <> '')
);

-- Materialised calendar. Off days always carry the reason shown to users ("Sunday",
-- "2nd Saturday", "Dussehra"); working days carry none.
create table public.calendar_days (
  day date primary key,
  is_working boolean not null,
  reason text,
  constraint calendar_days_reason_only_on_off_days check (is_working = (reason is null))
);

-- PRD 6.2: a day is a working day when it is not a Sunday, not a 2nd, 4th or 5th Saturday
-- (only the 1st and 3rd Saturdays work; N2: 5th Saturdays are off) and not a holiday.
-- A Saturday's position is ceil(day_of_month / 7). A holiday's name wins over the weekday
-- reason (Diwali on a Sunday reads "Diwali").
-- Rebuilds calendar_days for [p_from, p_to]; running it again gives the same rows.
create function public.refresh_calendar(p_from date, p_to date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  -- PRD 9.1: admin only (or a trusted session, such as the migration that builds it first).
  if not (knit_is_trusted() or knit_is_admin()) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;

  insert into calendar_days (day, is_working, reason)
  select c.day, c.reason is null, c.reason
  from (
    select g.d::date as day,
           case
             when h.name is not null then h.name
             when extract(isodow from g.d) = 7 then 'Sunday'
             when extract(isodow from g.d) = 6
                  and (extract(day from g.d)::int + 6) / 7 not in (1, 3)
               then case (extract(day from g.d)::int + 6) / 7
                      when 2 then '2nd'
                      when 4 then '4th'
                      else '5th'
                    end || ' Saturday'
           end as reason
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g (d)
    left join holidays h on h.day = g.d::date
  ) c
  on conflict (day) do update
    set is_working = excluded.is_working,
        reason = excluded.reason;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- PRD 6.2, 9.1: calendar lookups. A date outside the materialised calendar is an error, never
-- a guess (CLAUDE.md invariant 7); Sync health warns 60 days before the calendar ends.
create function public.is_working_day(d date)
returns boolean
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_working boolean;
begin
  select is_working into v_working from calendar_days where day = d;
  if not found then
    raise exception 'calendar_not_covered'
      using detail = format('The working-day calendar has no entry for %s. Extend it with refresh_calendar.', d);
  end if;
  return v_working;
end;
$$;

-- The first working day after d.
create function public.next_working_day(d date)
returns date
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_next date;
begin
  perform is_working_day(d);
  select min(day) into v_next from calendar_days where day > d and is_working;
  if v_next is null then
    raise exception 'calendar_not_covered'
      using detail = format('The working-day calendar ends before the next working day after %s. Extend it with refresh_calendar.', d);
  end if;
  return v_next;
end;
$$;

-- The last working day before d.
create function public.prev_working_day(d date)
returns date
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_prev date;
begin
  perform is_working_day(d);
  select max(day) into v_prev from calendar_days where day < d and is_working;
  if v_prev is null then
    raise exception 'calendar_not_covered'
      using detail = format('The working-day calendar starts after the last working day before %s. Extend it with refresh_calendar.', d);
  end if;
  return v_prev;
end;
$$;

-- PRD 6.2: the calendar is refreshed whenever holidays change. This trigger refreshes each
-- changed day inside the current calendar range, so calendar_days cannot drift from the
-- holiday list, whoever edits it.
create function public.holidays_refresh_calendar()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_first date;
  v_last date;
begin
  select min(day), max(day) into v_first, v_last from calendar_days;
  if v_first is null then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.day between v_first and v_last then
    perform refresh_calendar(old.day, old.day);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.day between v_first and v_last then
    perform refresh_calendar(new.day, new.day);
  end if;
  return null;
end;
$$;

create trigger holidays_refresh_calendar
  after insert or update or delete on public.holidays
  for each row execute function public.holidays_refresh_calendar();

revoke all on function public.refresh_calendar(date, date) from public, anon;
revoke all on function public.is_working_day(date) from public, anon;
revoke all on function public.next_working_day(date) from public, anon;
revoke all on function public.prev_working_day(date) from public, anon;
revoke all on function public.holidays_refresh_calendar() from public, anon, authenticated;
grant execute on function public.refresh_calendar(date, date) to authenticated, service_role;
grant execute on function public.is_working_day(date) to authenticated, service_role;
grant execute on function public.next_working_day(date) to authenticated, service_role;
grant execute on function public.prev_working_day(date) to authenticated, service_role;
