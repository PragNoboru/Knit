import "server-only";

import { timingSafeEqual } from "node:crypto";

import { getServerEnv, type ServerEnv } from "@/lib/env";
import { sheetSourceFor } from "@/lib/sheets/factory";
import { serviceRpc } from "@/lib/supabase/service";
import {
  GoogleArchive,
  localArchive,
  type ArchiveSink,
} from "@/lib/sync/archive";
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
    archive: archiveFor(env),
  };
}

/** PRD 10.7: the Knit Archive sheet in production; a local file in local mode (N16). */
function archiveFor(env: ServerEnv): ArchiveSink {
  return env.KNIT_SHEET_SOURCE === "google"
    ? new GoogleArchive(env.KNIT_ARCHIVE_SHEET_ID, {
        credentials: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      })
    : localArchive();
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
  try {
    const run = await withJobLease(job, maxDurationSeconds, work);
    return run.skipped
      ? Response.json({ ok: true, skipped: "another run holds the lease" })
      : Response.json({ ok: true, ...run.result });
  } catch (error) {
    logEvent(`${job}.error`, { job, error: errorSummary(error) });
    return Response.json({ ok: false, error: "job_failed" }, { status: 500 });
  }
}

/**
 * Runs `work` under the job's lease and time budget. The cron endpoints use it through
 * runJob; a server action that has already checked the signed-in user uses it directly
 * (Sync now, PRD 7.3). `skipped` when another run holds the lease; that call is recorded as a
 * "skipped" run (PRD 19), so an overlap shows in Sync health.
 */
export async function withJobLease<T>(
  job: string,
  maxDurationSeconds: number,
  work: (
    deps: Awaited<ReturnType<typeof jobDeps>> & { deadline: number },
  ) => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const deps = await jobDeps();
  const startedAt = new Date().toISOString();
  const deadline = deadlineFor(maxDurationSeconds);
  const holder = await acquire(deps.store, job, maxDurationSeconds);
  if (!holder) {
    await recordLeaseSkipped(deps.store, job, startedAt);
    return { skipped: true };
  }
  try {
    return { skipped: false, result: await work({ ...deps, deadline }) };
  } finally {
    await deps.store.releaseLease(job, holder);
  }
}

type RunRecord = Parameters<SyncStore["recordRun"]>[0];

/** Writes a sync_runs row; a failure to record is logged and never fails the job itself. */
async function record(store: SyncStore, run: RunRecord): Promise<void> {
  try {
    await store.recordRun(run);
  } catch (error) {
    logEvent("sync_run.record_failed", {
      job: run.job,
      error: errorSummary(error),
    });
  }
}

/** PRD 19, 7.3: a call that found the job's lease held did nothing; Sync health says so. */
export function recordLeaseSkipped(
  store: SyncStore,
  job: string,
  startedAt: string,
): Promise<void> {
  return record(store, {
    job,
    startedAt,
    ok: true,
    stats: { outcome: "skipped", reason: "another call holds the lease" },
  });
}

export interface RunSummary {
  /** false for a call that found nothing to do: it writes no row (record_sync_run). */
  record: boolean;
  ok: boolean;
  stats: Record<string, unknown>;
  error?: string | null;
}

/**
 * PRD 19: runs one push or close call and records it in sync_runs when it did work or failed.
 * A call that throws is recorded as failed, with the error's code, and the error goes on.
 */
export async function recordedRun<T>(
  store: SyncStore,
  job: string,
  work: () => Promise<T>,
  summarise: (result: T) => RunSummary,
): Promise<T> {
  const startedAt = new Date().toISOString();
  let result: T;
  try {
    result = await work();
  } catch (error) {
    await record(store, {
      job,
      startedAt,
      ok: false,
      stats: { outcome: "failed" },
      error: errorSummary(error),
    });
    throw error;
  }
  const summary = summarise(result);
  if (summary.record)
    await record(store, {
      job,
      startedAt,
      ok: summary.ok,
      stats: summary.stats,
      error: summary.error ?? null,
    });
  return result;
}

/** 10.4: a push call is worth a row when it claimed write-backs; retries and failures fail it. */
export function pushRunSummary(stats: {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}): RunSummary {
  const problems = stats.retried + stats.failed;
  return {
    record: stats.claimed > 0,
    ok: problems === 0,
    stats: { ...stats },
    error:
      problems === 0
        ? null
        : `${stats.retried} write-backs wait for a retry, ${stats.failed} failed`,
  };
}

/** 10.5: a close call is worth a row when it closed a day or failed on one. */
export function closeRunSummary(result: {
  closed: { day: string }[];
  failed: { day: string; error: string } | null;
}): RunSummary {
  return {
    record: result.closed.length > 0 || result.failed !== null,
    ok: result.failed === null,
    stats: {
      // Numbers and text, as Sync health lists them.
      closed: result.closed.length,
      ...(result.closed.length > 0
        ? { days: result.closed.map((c) => c.day).join(", ") }
        : {}),
      ...(result.failed ? { failedDay: result.failed.day } : {}),
    },
    error: result.failed?.error ?? null,
  };
}

async function acquire(
  store: SyncStore,
  job: string,
  ttlSeconds: number,
): Promise<string | null> {
  return store.acquireLease(job, ttlSeconds + 30);
}
