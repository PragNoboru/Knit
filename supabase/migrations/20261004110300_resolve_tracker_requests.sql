-- PRD N86, 9.1: a request ends as Connected when any tracker on its file becomes active, and
-- its Needs Attention item is resolved, in the same transaction as the change of state
-- (set_tracker_state, from Activate or Resume, or a tracker inserted as active). Only an open
-- request changes: a dismissed one stays dismissed even if the file is connected later. A
-- draft does not end a request, since a setup can be abandoned. Running it again finds nothing
-- open, so a pause and a second activation change nothing more.

create function public.resolve_tracker_requests()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state = 'active' and (tg_op = 'INSERT' or old.state is distinct from 'active') then
    update tracker_requests
    set state = 'connected', tracker_id = new.id, resolved_at = now()
    where file_id = new.file_id and state = 'open';
    update attention_items
    set state = 'resolved', resolved_at = now()
    where kind = 'tracker_request' and state = 'open' and tracker_id is null
      and dedupe_key = 'tracker_request:' || new.file_id;
  end if;
  return null;
end;
$$;

revoke all on function public.resolve_tracker_requests() from public, anon, authenticated;

create trigger trackers_resolve_tracker_requests
  after insert or update of state on public.trackers
  for each row execute function public.resolve_tracker_requests();
