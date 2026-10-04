import type { SheetSource } from "@/lib/sheets/types";

import { errorCode, errorSummary, logEvent } from "./log";
import type { SyncStore } from "./store";

/**
 * PRD 10.1: list the Knit folder and record it. New native sheets show under "New sheet found";
 * other files as "Not a Google Sheet"; a sheet that left the folder pauses its trackers.
 */
export async function discover(deps: {
  store: SyncStore;
  source: SheetSource;
}) {
  const runId = await deps.store.startRun("discover");
  try {
    const files = await deps.source.listFolder();
    const summary = await deps.store.recordDriveListing(files);
    await deps.store.finishRun(runId, true, summary);
    logEvent("discover.done", { job: "discover", run: runId, ...summary });
    return summary;
  } catch (error) {
    // The message goes to sync_runs.error, which only the admin reads (Sync health). The log
    // carries the code and HTTP status only: a request check runs discover too, and its logs
    // never hold an error message (N88).
    await deps.store.finishRun(runId, false, {}, errorSummary(error));
    logEvent("discover.failed", {
      job: "discover",
      run: runId,
      ...errorCode(error),
    });
    throw error;
  }
}
