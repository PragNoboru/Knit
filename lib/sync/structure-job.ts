import { SheetError } from "@/lib/sheets/types";
import { diffDays } from "@/lib/time";

import { errorSummary, logEvent } from "./log";
import type { SyncStore } from "./store";
import { checkStructure } from "./structure";
import type { SheetSource } from "@/lib/sheets/types";

/**
 * PRD 7.3, 10.2 step 2, N6: the daily structure check (06:30 IST). Re-verifies the headers,
 * formula columns and Knit columns of every active tracker and pauses any that no longer
 * match its registry. It also raises calendar_ending when the working-day calendar ends within
 * 60 days (6.2), so it is extended in time.
 */
export const CALENDAR_WARNING_DAYS = 60;

export async function structureCheckAll(deps: {
  store: SyncStore;
  source: SheetSource;
}) {
  const { store, source } = deps;
  const runId = await store.startRun("structure");
  let checked = 0;
  let paused = 0;
  const failures: string[] = [];
  for (const tracker of await store.trackers()) {
    const ref = { fileId: tracker.fileId, sheetId: tracker.sheetGid };
    try {
      checked += 1;
      const problem = checkStructure(
        await source.readStructure(ref, tracker.config.headerRow),
        tracker.config,
      );
      if (problem) {
        await store.pauseTracker(
          tracker.id,
          problem.reason,
          problem.kind,
          problem.dedupeKey,
          problem.detail,
        );
        paused += 1;
      }
    } catch (error) {
      if (
        error instanceof SheetError &&
        (error.code === "file_not_found" || error.code === "tab_not_found")
      ) {
        await store.pauseTracker(
          tracker.id,
          "the sheet or tab cannot be found",
          "missing_header",
          "missing_tab",
          {},
        );
        paused += 1;
      } else {
        failures.push(tracker.id);
        logEvent("structure.tracker_failed", {
          job: "structure",
          tracker: tracker.id,
          error: errorSummary(error),
        });
      }
    }
  }

  const today = await store.today();
  const { calendar } = await store.loadContext();
  const last = calendar.at(-1)?.day ?? null;
  const calendarEnding =
    last === null || diffDays(last, today) < CALENDAR_WARNING_DAYS;
  if (calendarEnding) {
    await store.raiseAttention(
      null,
      null,
      "calendar_ending",
      "calendar_ending",
      { last },
    );
  }

  const stats = { checked, paused, failed: failures.length, calendarEnding };
  await store.finishRun(runId, failures.length === 0, stats);
  logEvent("structure.done", {
    job: "structure",
    run: runId,
    checked,
    paused,
    failed: failures.length,
  });
  return stats;
}
