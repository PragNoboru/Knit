-- PRD 10.1 ("If it comes back, the admin presses Resume"), D14 (only sheets inside the Knit
-- folder are synced), 14 (sheet moved out of the folder: tracker paused), invariant 7.
--
-- set_tracker_state again, with one more rule: a paused tracker whose sheet is still outside
-- the Knit folder (drive_files.state 'left_folder') cannot become active: 'file_outside_folder'.
-- Discover pauses a tracker only when its file first leaves the folder, so a tracker resumed
-- while its sheet is still out would otherwise stay active and keep syncing a sheet outside the
-- folder. The Resume action (lib/actions/admin.ts) lists the folder first, so a sheet that came
-- back counts as back, and checks the tab before it calls this.
--
-- Everything else is as in 20260928100000_admin.sql.

create or replace function public.set_tracker_state(
  p_tracker_id uuid,
  p_state tracker_state,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old tracker_state;
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  select state into v_old from trackers where id = p_tracker_id for update;
  if not found then
    raise exception 'tracker_not_found' using errcode = 'P0002';
  end if;
  if v_old = p_state then
    return;
  end if;
  if not (
    (v_old = 'draft' and p_state in ('active', 'archived'))
    or (v_old = 'active' and p_state in ('paused', 'archived'))
    or (v_old = 'paused' and p_state in ('active', 'archived'))
  ) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;
  if v_old = 'paused' and p_state = 'active' and exists (
    select 1 from trackers t join drive_files f on f.file_id = t.file_id
    where t.id = p_tracker_id and f.state = 'left_folder'
  ) then
    raise exception 'file_outside_folder' using errcode = '22023';
  end if;

  update trackers
  set state = p_state,
      pause_reason = case when p_state = 'paused' then coalesce(nullif(btrim(p_reason), ''), 'Paused by the admin') end
  where id = p_tracker_id;

  if v_old = 'paused' and p_state = 'active' then
    update outbox set state = 'pending', next_attempt_at = now()
    where tracker_id = p_tracker_id and state = 'held';
    update attention_items set state = 'resolved', resolved_at = now()
    where tracker_id = p_tracker_id and state = 'open'
      and kind in ('missing_header', 'missing_knit_id_column');
  end if;
end;
$$;

revoke all on function public.set_tracker_state(uuid, public.tracker_state, text)
  from public, anon, authenticated;
grant execute on function public.set_tracker_state(uuid, public.tracker_state, text)
  to service_role;
