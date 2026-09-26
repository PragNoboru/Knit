import "server-only";

import { jobDeps } from "@/lib/jobs/cron";

import { errorSummary, logEvent } from "./log";
import { pushDue } from "./push";

/**
 * PRD 7.3: after a status change the server action pushes that task's write-back straight
 * away (best effort, 5 s), so most writes land within seconds. Failures are only logged: the
 * cron push retries every minute.
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
      pushDue({ store, source }, { taskId }),
      timeout,
    ]);
    if (result === "timeout")
      logEvent("push.immediate_timeout", { task: taskId });
  } catch (error) {
    logEvent("push.immediate_failed", {
      task: taskId,
      error: errorSummary(error),
    });
  }
}
