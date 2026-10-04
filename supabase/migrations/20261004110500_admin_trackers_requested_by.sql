-- PRD N86, 11 step 1, 12.8: New sheet found shows "Requested by {name}" under a sheet that has
-- an open request. admin_trackers as in 20260928100000_admin.sql, with one more field on each
-- file: requestedBy, the name of the person whose request on the file is open, or null.

create or replace function public.admin_trackers()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'trackers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'color', t.color, 'state', t.state,
        'pauseReason', t.pause_reason, 'fileId', t.file_id, 'gid', t.sheet_gid,
        'tabName', t.tab_name, 'fileName', f.name, 'lastPullAt', t.last_pull_at,
        'goLiveDate', t.go_live_date,
        'taskCount', (select count(*) from tasks k where k.tracker_id = t.id and k.removed_at_source is null),
        'backlogCount', (select count(*) from tasks k where k.tracker_id = t.id and k.history_only
                           and k.removed_at_source is null and k.status not in ('done', 'cancelled')),
        'openAttention', (select count(*) from attention_items a where a.tracker_id = t.id and a.state = 'open')
      ) order by t.state = 'archived', t.name)
      from trackers t join drive_files f on f.file_id = t.file_id), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'fileId', f.file_id, 'name', f.name, 'state', f.state, 'modifiedTime', f.modified_time,
        'trackers', (select count(*) from trackers t where t.file_id = f.file_id and t.state <> 'archived'),
        -- N86: the requester of the file's open request (at most one, N87).
        'requestedBy', (select u.name from tracker_requests r join app_users u on u.id = r.requested_by
                        where r.file_id = f.file_id and r.state = 'open'))
        order by f.name)
      from drive_files f
      where f.state in ('new', 'ignored', 'not_a_sheet')
         or (f.state = 'connected' and not exists (
               select 1 from trackers t where t.file_id = f.file_id and t.state <> 'draft'))), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_trackers() from public, anon;
grant execute on function public.admin_trackers() to authenticated;
