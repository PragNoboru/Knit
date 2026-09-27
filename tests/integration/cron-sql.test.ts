import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// PRD 18.2, RUNBOOK 2.4 and 5 (audit finding 42): supabase/sql/cron.sql can be run again, for
// example after `supabase db reset --linked`, which keeps the Vault secrets. It runs on a
// PGlite database of its own, against stand-ins for Supabase's vault, pg_net and pg_cron, so
// the jobs of a real database (local Supabase included) are never touched.

const cronSql = readFileSync(
  fileURLToPath(new URL("../../supabase/sql/cron.sql", import.meta.url)),
  "utf8",
);

// Supabase's own objects that cron.sql uses, with the same names and arguments.
const STAND_INS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema if not exists extensions;
  create schema vault;
  create table vault.secrets (
    id uuid primary key default gen_random_uuid(),
    name text,
    secret text not null
  );
  create unique index secrets_name_idx on vault.secrets (name) where name is not null;
  create view vault.decrypted_secrets as
    select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null)
  returns uuid language sql as $$
    insert into vault.secrets (name, secret) values (new_name, new_secret) returning id
  $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null)
  returns void language sql as $$
    update vault.secrets set secret = new_secret where id = secret_id
  $$;
  create schema net;
  create function net.http_post(
    url text, body jsonb default '{}', params jsonb default '{}',
    headers jsonb default '{}', timeout_milliseconds integer default 5000)
  returns bigint language sql as $$ select 1::bigint $$;
  create schema cron;
  create table cron.job (jobname text primary key, schedule text, command text);
  create function cron.schedule(job_name text, schedule text, command text)
  returns bigint language sql as $$
    insert into cron.job values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning 1::bigint
  $$;
`;

/** cron.sql as the admin runs it: placeholders filled in; PGlite cannot create extensions. */
const filled = (url: string, secret: string) =>
  cronSql
    .replace(/^create extension .*$/gm, "")
    .replace("https://<app>.vercel.app", url)
    .replace("<same value as KNIT_CRON_SECRET>", secret);

describe("supabase/sql/cron.sql", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(STAND_INS);
  });
  afterEach(() => db.close());
  const rows = async (sql: string) => (await db.query(sql)).rows;

  it("can be run again, and a second run changes the URL and the secret", async () => {
    await db.exec(filled("https://knit-old.vercel.app", "first-secret"));
    await db.exec(filled("https://knit.vercel.app", "second-secret"));
    expect(
      await rows(
        "select name, decrypted_secret from vault.decrypted_secrets order by name",
      ),
    ).toEqual([
      { name: "knit_app_url", decrypted_secret: "https://knit.vercel.app" },
      { name: "knit_cron_secret", decrypted_secret: "second-secret" },
    ]);
    expect(
      await rows("select jobname, schedule from cron.job order by jobname"),
    ).toEqual([
      { jobname: "knit-close", schedule: "*/15 * * * *" },
      { jobname: "knit-pull", schedule: "*/10 * * * *" },
      { jobname: "knit-push", schedule: "* * * * *" },
      { jobname: "knit-structure", schedule: "0 1 * * *" },
    ]);
  });

  it("keeps the pg_net timeout equal to the job functions' maxDuration (RUNBOOK 2.3)", () => {
    const routes = ["pull", "push", "close", "structure"].map((job) =>
      readFileSync(
        fileURLToPath(
          new URL(`../../app/api/jobs/${job}/route.ts`, import.meta.url),
        ),
        "utf8",
      ),
    );
    const durations = routes.map(
      (source) => /export const maxDuration = (\d+);/.exec(source)?.[1],
    );
    const timeout = /timeout_milliseconds := (\d+)/.exec(cronSql)?.[1];
    expect(new Set(durations).size).toBe(1);
    expect(Number(timeout)).toBe(Number(durations[0]) * 1000);
  });
});
