import type { SheetSource } from "@/lib/sheets/types";

import { pushDue, type PushStats } from "./push";
import type { SyncStore } from "./store";

/**
 * PRD 7.3, 14 ("Job overlap: lease prevents it"): every piece of work that pulls or pushes
 * holds that job's lease, whoever starts it: the cron endpoints, Sync now, the admin's actions,
 * the close-days job's own pull and push (10.5 step 2) and the immediate push after a status
 * change. Two pulls of one tracker could otherwise write competing Knit IDs (invariant 3), and
 * two pushes could write a task's older write-back after its newer one (10.4 step 1).
 */

export interface LeaseOptions {
  /** How long the lease lasts if the holder dies without releasing it. */
  ttlSeconds: number;
  /** How long to keep asking while another holder has it; 0 gives up at once. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `work` holding `job`'s lease; `skipped` when another holder keeps it. */
export async function withLease<T>(
  store: SyncStore,
  job: string,
  options: LeaseOptions,
  work: () => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const pollMs = options.pollMs ?? 2_000;
  const sleep = options.sleep ?? pause;
  const ttl = Math.max(1, Math.ceil(options.ttlSeconds));
  let holder = await store.acquireLease(job, ttl);
  for (
    let waited = 0;
    holder === null && waited < (options.waitMs ?? 0);
    waited += pollMs
  ) {
    await sleep(pollMs);
    holder = await store.acquireLease(job, ttl);
  }
  if (holder === null) return { skipped: true };
  try {
    return { skipped: false, result: await work() };
  } finally {
    await store.releaseLease(job, holder);
  }
}

/**
 * The immediate push's lease TTL: the server action's maxDuration (app/(app)/layout.tsx), the
 * longest the invocation that holds the lease can run.
 */
export const IMMEDIATE_PUSH_TTL_SECONDS = 60;

/**
 * PRD 7.3: the immediate push of one task's write-back after a status change, under the push
 * lease. When a push is already running it is skipped: that push may be writing this task's
 * older write-back, and the newer one must land after it (10.4 step 1). The cron push, every
 * minute, is the retry path.
 */
export async function pushTaskUnderLease(
  deps: { store: SyncStore; source: SheetSource },
  taskId: string,
  options: { ttlSeconds?: number; deadline?: number } = {},
): Promise<{ skipped: true } | { skipped: false; result: PushStats }> {
  return withLease(
    deps.store,
    "push",
    { ttlSeconds: options.ttlSeconds ?? IMMEDIATE_PUSH_TTL_SECONDS },
    () => pushDue(deps, { taskId, deadline: options.deadline }),
  );
}

/**
 * PRD 7.3, N33: the immediate push as the server action runs it, after its response is sent
 * (next/server `after`). The leased push is awaited to its end, so `after` keeps the
 * invocation alive until the lease is released. Returning at the 5 s mark instead would leave
 * the push running in an invocation the platform may freeze or end with the lease still held,
 * and every push would be skipped until the lease expired. The 5 s budget is reported (`slow`),
 * never used to walk away from a push that holds the lease.
 */
export async function pushTaskImmediately(
  deps: { store: SyncStore; source: SheetSource },
  taskId: string,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<{ skipped: boolean; slow: boolean }> {
  const now = options.now ?? Date.now;
  const started = now();
  const run = await pushTaskUnderLease(deps, taskId);
  return {
    skipped: run.skipped,
    slow: now() - started > (options.timeoutMs ?? 5_000),
  };
}
