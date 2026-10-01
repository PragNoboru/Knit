-- PRD N28 (decided 1 Oct 2026), N60, 6.8, 10.3, N44, 8.1 (tasks.source_snapshot, state_version),
-- 9.1 (apply_pull_plan), invariant 8.
--
-- DEPLOY ORDER: merge first so Vercel deploys the code that reads null as "unmapped when
-- read", then run `pnpm exec supabase db push`. The code from before N28 reads a null status
-- as a source change on every pull: it would write 'yet_to_start' back over the nulls (losing
-- N60 for those rows for good, as this runs once) and raise a conflict on every pull for a
-- task changed in Knit. On a database that already holds tasks, check afterwards that this
-- returns 0 (snapshots of words still unmapped that record a status):
--   select count(*) from public.tasks k join public.trackers t on t.id = k.tracker_id
--   where k.source_snapshot ? 'statusKey'
--     and (k.source_snapshot -> 'status') is distinct from 'null'::jsonb
--     and not (coalesce(t.config -> 'statusMap', '{}'::jsonb) ? (k.source_snapshot ->> 'statusKey'));
--
-- source_snapshot keeps, with the status word, the Knit status the word stood for when Knit
-- read or wrote it, or JSON null when the word was unmapped then (6.8). While a row shows the
-- same word the pull reads it as that recorded status, so remapping a word changes no existing
-- task (N28). A word recorded null and mapped since is a change made in the source: the next
-- pull applies it to every row that shows it, under 10.3 (N60).
--
-- Until now an unmapped word was recorded as 'yet_to_start', like a word mapped to Yet to
-- Start, so N60 could not tell the two apart. This one-off data fix records JSON null for:
--   (a) a snapshot whose word is not in the tracker's status map now (still unmapped), with or
--       without a recorded status (snapshots saved before the status was recorded have no
--       'status' key: jsonb_set creates it);
--   (b) a snapshot recorded as 'yet_to_start' whose word the map now gives another status, on
--       a tracker that has an unmapped_status item for that word in any state: the admin
--       mapped it for the first time (N19 d) and no pull has applied it yet.
-- A word mapped to Yet to Start keeps its recorded status. Only source_snapshot and the
-- trackers' state_version and pull_requested change: no task status, task-day, event, outbox
-- row or sheet cell.
--
-- Concurrency (9.1, as close_day_moves_state_version, 20260930100000): the trackers are locked
-- first, in id order, the order apply_pull_plan takes its locks (tracker, then tasks), so a
-- pull applied at the same time waits instead of deadlocking. Every tracker with a changed
-- snapshot moves its state_version, so a pull planned before this ran answers 'retry' and
-- plans again, instead of writing the old 'yet_to_start' back over the nulls.
--
-- N44: a tracker with (b) rows is owed a pull, so the first mapping reaches its rows without
-- waiting for a sheet edit. Like knit_request_pull_everywhere, only active and paused
-- trackers. Rows nulled under (a) need no pull: the word is still unmapped.
--
-- Idempotent (invariant 8): a snapshot already recording null is skipped, so a second run
-- changes no row, moves no state_version and owes no pull.
do $$
declare
  v_touched uuid[];
  v_owed uuid[];
begin
  perform 1 from public.trackers order by id for update;

  with touched as (
    update public.tasks k
    set source_snapshot = jsonb_set(k.source_snapshot, '{status}', 'null'::jsonb, true)
    from public.trackers t
    where t.id = k.tracker_id
      and k.source_snapshot ? 'statusKey'
      and (k.source_snapshot -> 'status') is distinct from 'null'::jsonb
      and (
        not (coalesce(t.config -> 'statusMap', '{}'::jsonb) ? (k.source_snapshot ->> 'statusKey'))
        or (
          k.source_snapshot ->> 'status' = 'yet_to_start'
          and t.config -> 'statusMap' ->> (k.source_snapshot ->> 'statusKey') <> 'yet_to_start'
          and exists (
            select 1 from public.attention_items a
            where a.tracker_id = t.id
              and a.kind = 'unmapped_status'
              and a.dedupe_key = 'unmapped_status:' || (k.source_snapshot ->> 'statusKey')
          )
        )
      )
    returning
      k.tracker_id,
      coalesce(t.config -> 'statusMap', '{}'::jsonb) ? (k.source_snapshot ->> 'statusKey') as now_mapped
  )
  select
    coalesce(array_agg(distinct tracker_id), '{}'),
    coalesce(array_agg(distinct tracker_id) filter (where now_mapped), '{}')
  into v_touched, v_owed
  from touched;

  update public.trackers
  set state_version = state_version + 1,
      pull_requested = pull_requested
        + case when id = any (v_owed) and state in ('active', 'paused') then 1 else 0 end
  where id = any (v_touched);
end;
$$;
