import { execSync } from "node:child_process";

/**
 * API URL and service-role key of the local Supabase, for tests that go through the Auth API.
 * CI exports them from `supabase status -o env`; locally they are read from the CLI.
 * These are the well-known local development keys, not secrets.
 */
export function localSupabaseApi(): { url: string; serviceRoleKey: string } {
  let url = process.env.API_URL;
  let serviceRoleKey = process.env.SERVICE_ROLE_KEY ?? process.env.SECRET_KEY;
  if (!url || !serviceRoleKey) {
    const status = JSON.parse(
      execSync("pnpm exec supabase status -o json", { encoding: "utf8" }),
    ) as Record<string, string | undefined>;
    url = status.API_URL;
    serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  }
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Local Supabase is not running: start it with `pnpm exec supabase start`.",
    );
  }
  return { url, serviceRoleKey };
}
