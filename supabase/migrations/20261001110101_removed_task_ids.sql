-- PRD 10.4 step 2, N11, N30, N59: which of the push's claimed tasks are removed at source now.
--
-- push_claim (20261001110000) says whether each claimed task was removed at source when it was
-- claimed. The pull and the push hold separate leases (7.3) and can run at the same time, so a
-- pull may mark a claimed task removed (its row was missing) and the row may be put back
-- before the push reads the sheet. The push then would find the returning row by the removed
-- task's Knit ID. N59: "a returning row never takes the removed task's values". So the push
-- asks again just after reading the rows, and fails the write-backs of these tasks with
-- row_not_found without looking for their rows. Read only. Service role only. Forward-only.

create function public.removed_task_ids(p_task_ids uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not knit_is_trusted() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  return coalesce((
    select array_agg(k.id order by k.id)
    from tasks k
    where k.id = any (p_task_ids) and k.removed_at_source is not null
  ), '{}');
end;
$$;

revoke all on function public.removed_task_ids(uuid[]) from public, anon, authenticated;
grant execute on function public.removed_task_ids(uuid[]) to service_role;
