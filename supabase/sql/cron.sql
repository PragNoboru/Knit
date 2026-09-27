-- PRD 18.2: register the jobs. Run ONCE in the Supabase SQL editor after the first production
-- deploy (docs/RUNBOOK.md). Not a migration: it needs the real app URL and cron secret, which
-- must never be committed. Replace both placeholders before running.
--
-- pg_cron runs in UTC. Every call carries x-knit-cron-secret; the app rejects calls without it.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret('https://<app>.vercel.app', 'knit_app_url');
select vault.create_secret('<same value as KNIT_CRON_SECRET>', 'knit_cron_secret');

-- Posts to a job endpoint. The 60 s timeout matches the functions' maxDuration.
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
