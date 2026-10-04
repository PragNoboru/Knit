-- PRD N83, N84, N86, 9.1: saves a request the server action requestTracker has checked, and
-- tells the admin in Needs Attention, in one transaction. Service role only: the counts and the
-- template come from the server's dry run (N84), and the requester is the signed-in caller the
-- action read from the session.
--
-- The checks the action made against the database are made again here, under a lock on the
-- file's drive_files row. Inserting a tracker on the file takes a key-share lock on that same
-- row (trackers.file_id references it), so a request and a setup that start together for one
-- file run one after the other. The partial unique index of 20261004110000 keeps one open
-- request per file even so (N87); its unique_violation is answered as already_requested.
--
-- Outcomes: sent (with the request id), not_allowed (the user is not active), not_in_folder,
-- not_a_sheet, setting_up (a draft tracker on the file), already_tracker (an active or paused
-- one), archived (only archived ones), already_requested.

create function public.record_tracker_request(
  p_user_id uuid,
  p_file_id text,
  p_sheet_gid bigint,
  p_file_name text,
  p_template_id text,
  p_task_count int,
  p_unknown_names int,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_note constant text := nullif(btrim(coalesce(p_note, '')), '');
  v_state drive_file_state;
  v_mime text;
  v_states tracker_state[];
  v_id bigint;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_task_count is null or p_task_count < 1 or coalesce(p_unknown_names, -1) < 0
     or nullif(btrim(coalesce(p_file_name, '')), '') is null
     or nullif(btrim(coalesce(p_template_id, '')), '') is null
     or p_sheet_gid is null
     or char_length(coalesce(v_note, '')) > 280 then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if not coalesce((select is_active from app_users where id = p_user_id), false) then
    return jsonb_build_object('outcome', 'not_allowed');
  end if;

  select state, mime_type into v_state, v_mime
  from drive_files where file_id = p_file_id
  for update;
  if not found or v_state = 'left_folder' then
    return jsonb_build_object('outcome', 'not_in_folder');
  end if;
  if v_state = 'not_a_sheet' or v_mime is distinct from 'application/vnd.google-apps.spreadsheet' then
    return jsonb_build_object('outcome', 'not_a_sheet');
  end if;

  -- N84: no tracker in any state has the file.
  select array_agg(state) into v_states from trackers where file_id = p_file_id;
  if v_states is not null then
    if 'draft' = any (v_states) then
      return jsonb_build_object('outcome', 'setting_up');
    end if;
    if exists (select 1 from unnest(v_states) s where s <> 'archived') then
      return jsonb_build_object('outcome', 'already_tracker');
    end if;
    return jsonb_build_object('outcome', 'archived');
  end if;

  if exists (select 1 from tracker_requests where file_id = p_file_id and state = 'open') then
    return jsonb_build_object('outcome', 'already_requested');
  end if;

  begin
    insert into tracker_requests (requested_by, file_id, sheet_gid, file_name, template_id,
                                  task_count, unknown_names, note)
    values (p_user_id, p_file_id, p_sheet_gid, btrim(p_file_name), p_template_id,
            p_task_count, p_unknown_names, v_note)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'already_requested');
  end;

  -- N86: one item per file while it is open; it has no tracker, so it shows under Knit.
  -- admin_attention names the requester from detail.userId.
  insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
  values (null, null, 'tracker_request', 'tracker_request:' || p_file_id,
          jsonb_build_object(
            'requestId', v_id, 'userId', p_user_id, 'fileId', p_file_id,
            'fileName', btrim(p_file_name), 'taskCount', p_task_count,
            'unknownNames', p_unknown_names, 'templateId', p_template_id, 'note', v_note))
  on conflict (tracker_id, dedupe_key) where state = 'open'
    do update set detail = excluded.detail, created_at = now();

  return jsonb_build_object('outcome', 'sent', 'id', v_id);
end;
$$;

revoke all on function public.record_tracker_request(uuid, text, bigint, text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.record_tracker_request(uuid, text, bigint, text, text, int, int, text)
  to service_role;
