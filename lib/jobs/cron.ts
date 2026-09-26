import "server-only";

import { timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { sheetSourceFor } from "@/lib/sheets/factory";
import { serviceRpc } from "@/lib/supabase/service";
import { errorSummary, logEvent } from "@/lib/sync/log";
import { createSyncStore, type SyncStore } from "@/lib/sync/store";

/**
 * Shared plumbing for the job endpoints (PRD 7.3, 9.3):
 *   * every call must carry x-knit-cron-secret, compared in constant time;
 *   * each job holds a lease, so an overlapping call exits at once;
 *   * each call works within 80% of the function's maxDuration and leaves the rest for the
 *     next call.
 */

export const CRON_HEADER = "x-knit-cron-secret";

export function isAuthorisedCron(request: Request, secret: string): boolean {
  const given = Buffer.from(request.headers.get(CRON_HEADER) ?? "", "utf8");
  const expected = Buffer.from(secret, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function jobDeps() {
  const env = getServerEnv();
  return {
    env,
    store: createSyncStore(serviceRpc()),
    source: await sheetSourceFor(env),
  };
}

/** The deadline for a call's work: 80% of maxDuration (seconds) from now. */
export function deadlineFor(
  maxDurationSeconds: number,
  now = Date.now(),
): number {
  return now + maxDurationSeconds * 800;
}

/**
 * Runs `work` under the job's lease. Returns 401 without the secret, 200 {skipped} when another
 * call holds the lease, and 500 with an error code (never details) when the work throws.
 */
export async function runJob(
  request: Request,
  job: string,
  maxDurationSeconds: number,
  work: (
    deps: Awaited<ReturnType<typeof jobDeps>> & { deadline: number },
  ) => Promise<Record<string, unknown>>,
): Promise<Response> {
  const env = getServerEnv();
  if (!isAuthorisedCron(request, env.KNIT_CRON_SECRET)) {
    return Response.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }
  const deps = await jobDeps();
  const deadline = deadlineFor(maxDurationSeconds);
  const holder = await acquire(deps.store, job, maxDurationSeconds);
  if (!holder)
    return Response.json({ ok: true, skipped: "another run holds the lease" });
  try {
    const result = await work({ ...deps, deadline });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    logEvent(`${job}.error`, { job, error: errorSummary(error) });
    return Response.json({ ok: false, error: "job_failed" }, { status: 500 });
  } finally {
    await deps.store.releaseLease(job, holder);
  }
}

async function acquire(
  store: SyncStore,
  job: string,
  ttlSeconds: number,
): Promise<string | null> {
  return store.acquireLease(job, ttlSeconds + 30);
}
