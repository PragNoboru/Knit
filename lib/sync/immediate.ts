import "server-only";

import { jobDeps } from "@/lib/jobs/cron";

import { pushTaskImmediately } from "./leases";
import { errorSummary, logEvent } from "./log";

/**
 * PRD 7.3: after a status change the server action pushes that task's write-back straight
 * away (best effort, 5 s), so most writes land within seconds. It holds the push lease like
 * every push (10.4 step 1: a write-back already being written must land before the newer
 * one), so it is skipped while another push runs. The action's `after` waits for the leased
 * push to end, so the lease is always released by the invocation that took it (N33); a push
 * that takes longer than 5 s is logged. Failures are only logged: the cron push retries every
 * minute.
 */
export async function pushTaskNow(
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  try {
    const { store, source } = await jobDeps();
    const result = await pushTaskImmediately({ store, source }, taskId, {
      timeoutMs,
    });
    if (result.skipped) logEvent("push.immediate_skipped", { task: taskId });
    else if (result.slow) logEvent("push.immediate_timeout", { task: taskId });
  } catch (error) {
    logEvent("push.immediate_failed", {
      task: taskId,
      error: errorSummary(error),
    });
  }
}
