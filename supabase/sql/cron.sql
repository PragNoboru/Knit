-- PRD 18.2: register the jobs. Run in the Supabase SQL editor after the first production deploy
-- (docs/RUNBOOK.md 2.4). Not a migration: it needs the real app URL and cron secret, which must
-- never be committed. Replace both placeholders before running.
--
-- Safe to run again: the secrets are created or updated, the function is replaced and each job
-- is rescheduled by name. Running it again is also how the app URL or the cron secret changes,
-- and it is needed after `supabase db reset --linked` (RUNBOOK 5), which keeps the Vault
-- secrets but drops the function and the jobs.
--
-- pg_cron runs in UTC. Every call carries x-knit-cron-secret; the app rejects calls without it.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
declare
  v_secret record;
begin
  for v_secret in
    select * from (values
      ('knit_app_url', 'https://<app>.vercel.app'),
      ('knit_cron_secret', '<same value as KNIT_CRON_SECRET>')
    ) as s (name, value)
  loop
    if exists (select 1 from vault.secrets where name = v_secret.name) then
      perform vault.update_secret(
        (select id from vault.secrets where name = v_secret.name), v_secret.value);
    else
      perform vault.create_secret(v_secret.value, v_secret.name);
    end if;
  end loop;
end;
$$;

-- Posts to a job endpoint. The 60 s timeout matches the functions' maxDuration (RUNBOOK 2.3).
create or replace function public.knit_call_job(path text)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'knit_app_url') || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-knit-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'knit_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$;

-- Only pg_cron (running as postgres) calls it: it reads the secrets.
revoke all on function public.knit_call_job(text) from public, anon, authenticated;

select cron.schedule('knit-pull',      '*/10 * * * *', $$select public.knit_call_job('/api/jobs/pull')$$);
select cron.schedule('knit-push',      '* * * * *',    $$select public.knit_call_job('/api/jobs/push')$$);
select cron.schedule('knit-close',     '*/15 * * * *', $$select public.knit_call_job('/api/jobs/close')$$);
select cron.schedule('knit-structure', '0 1 * * *',    $$select public.knit_call_job('/api/jobs/structure')$$);
