-- PRD N59, N30, N17, CLAUDE.md invariant 8: the note refresh of a row that came back survives
-- the pull run that gave the row its new Knit ID.
--
-- N59: "Once the new task is saved, the pull queues a note-only write-back for it", so the
-- row's Knit Note stops describing the task removed at source. The new task is not always
-- saved by the pull that writes the new Knit ID: the row's date may be unreadable (no task
-- until it is fixed, 6.4), or the run may be killed, fail or go stale between writing the ID
-- and apply_pull_plan. The next pull then sees the new ID as an ordinary new row. So the pull
-- records each new Knit ID it is about to write on a returning row here, before writing it
-- (10.2 step 4), and after every applied plan queues the note refresh for each recorded ID
-- that now has a task, in whichever pull saved it, and forgets those IDs.
--
-- An ID recorded but never confirmed in the sheet (N20 clears or puts back a misplaced write)
-- never becomes a task, and nor does one whose row is deleted again before it is saved: such
-- an entry is never matched and does nothing. A pasted copy's new ID is never recorded (N59:
-- it is not a returning row). Service role only: no policies, no grants to signed-in users.
-- Forward-only.

create table public.returned_rows (
  knit_id uuid primary key,
  tracker_id uuid not null references public.trackers (id) on delete cascade,
  recorded_at timestamptz not null default now()
);
alter table public.returned_rows enable row level security;
revoke all on public.returned_rows from anon, authenticated;

-- N59, 10.2 step 4: the new Knit IDs about to be written on rows that came back. Running it
-- twice records nothing new (invariant 8).
create function public.record_returned_rows(p_tracker_id uuid, p_knit_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  insert into returned_rows (knit_id, tracker_id)
  select distinct id, p_tracker_id from unnest(coalesce(p_knit_ids, '{}')) as id
  on conflict (knit_id) do nothing;
end;
$$;

-- N59, N17: after an applied plan, queue a note-only write-back for every recorded returning
-- row whose new task is now saved, through enqueue_note_refresh (which skips a task removed
-- at source again, and a task with a write-back already waiting, since that push writes the
-- current note too), then forget those IDs. Returns the number of write-backs queued. A task
-- is saved once, so its refresh is queued once (invariant 8); a call that fails leaves the IDs
-- for the next applied pull.
create function public.refresh_returned_rows(p_tracker_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_count integer;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select array_agg(r.knit_id) into v_ids
  from returned_rows r
  join tasks k on k.id = r.knit_id
  where r.tracker_id = p_tracker_id;
  if v_ids is null then
    return 0;
  end if;
  v_count := enqueue_note_refresh(v_ids);
  delete from returned_rows where knit_id = any (v_ids);
  return v_count;
end;
$$;

revoke all on function public.record_returned_rows(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.record_returned_rows(uuid, uuid[]) to service_role;
revoke all on function public.refresh_returned_rows(uuid) from public, anon, authenticated;
grant execute on function public.refresh_returned_rows(uuid) to service_role;
