-- PRD N86, 9.1, 12.8: the admin dismisses a request with a one-line reason (D2: at most 140
-- characters), which the person sees with their request in the Guide (N85). The request and
-- its Needs Attention item are dismissed together. A dismissed request does not stop a new
-- request for the same file (the one-open-request index covers open requests only).

create function public.admin_dismiss_tracker_request(p_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason constant text := nullif(btrim(coalesce(p_reason, '')), '');
  v_file text;
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if char_length(v_reason) > 140 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  update tracker_requests
  set state = 'dismissed', dismiss_reason = v_reason, resolved_at = now(), resolved_by = auth.uid()
  where id = p_id and state = 'open'
  returning file_id into v_file;
  if v_file is null then
    raise exception 'request_not_open' using errcode = '22023';
  end if;
  update attention_items
  set state = 'dismissed', resolved_at = now()
  where kind = 'tracker_request' and state = 'open' and tracker_id is null
    and dedupe_key = 'tracker_request:' || v_file;
end;
$$;

revoke all on function public.admin_dismiss_tracker_request(bigint, text) from public, anon;
grant execute on function public.admin_dismiss_tracker_request(bigint, text) to authenticated;

-- 12.8: Dismiss an item, or mark it resolved. As in 20260928100000_admin.sql, with one more
-- rule (N86): a tracker_request item is answered only through admin_dismiss_tracker_request,
-- with a reason the person sees, or by its tracker becoming active, so this refuses it with
-- request_needs_reason.
create or replace function public.admin_set_attention_state(p_id bigint, p_state text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if p_state not in ('resolved', 'dismissed') then
    raise exception 'invalid_state' using errcode = '22023';
  end if;
  if (select kind from attention_items where id = p_id) = 'tracker_request' then
    raise exception 'request_needs_reason' using errcode = '22023';
  end if;
  update attention_items set state = p_state, resolved_at = now()
  where id = p_id and state = 'open';
end;
$$;

revoke all on function public.admin_set_attention_state(bigint, text) from public, anon;
grant execute on function public.admin_set_attention_state(bigint, text) to authenticated;
