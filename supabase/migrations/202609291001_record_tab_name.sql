-- PRD 7.4, 14 ("Tab renamed: no effect"): tabs are identified by sheetId (gid), never by name,
-- so a renamed tab keeps syncing; the pull records the tab's current name here, so the admin
-- screens show the name the sheet uses now. A blank name is never recorded. Service role only.
create function public.record_tab_name(p_tracker_id uuid, p_tab_name text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update trackers
  set tab_name = p_tab_name
  where id = p_tracker_id
    and nullif(btrim(p_tab_name), '') is not null
    and tab_name is distinct from p_tab_name;
end;
$$;

revoke all on function public.record_tab_name(uuid, text) from public, anon, authenticated;
grant execute on function public.record_tab_name(uuid, text) to service_role;
