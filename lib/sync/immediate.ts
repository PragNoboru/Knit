import "server-only";

import { jobDeps } from "@/lib/jobs/cron";

import { pushTaskUnderLease } from "./leases";
import { errorSummary, logEvent } from "./log";

/**
 * PRD 7.3: after a status change the server action pushes that task's write-back straight
 * away (best effort, 5 s), so most writes land within seconds. It holds the push lease like
 * every push (10.4 step 1: a write-back already being written must land before the newer
 * one), so it is skipped while another push runs. Failures are only logged: the cron push
 * retries every minute.
 */
export async function pushTaskNow(
  taskId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  try {
    const { store, source } = await jobDeps();
    const result = await Promise.race([
      pushTaskUnderLease({ store, source }, taskId),
      timeout,
    ]);
    if (result === "timeout")
      logEvent("push.immediate_timeout", { task: taskId });
    else if (result.skipped)
      logEvent("push.immediate_skipped", { task: taskId });
  } catch (error) {
    logEvent("push.immediate_failed", {
      task: taskId,
      error: errorSummary(error),
    });
  }
}
