import { normaliseKey } from "@/lib/domain/config";
import { cellOf, textOf } from "@/lib/domain/rows";
import { writeBackFor } from "@/lib/domain/status";
import { KNIT_ID_HEADER, type SheetSource } from "@/lib/sheets/types";
import type { LocalDate } from "@/lib/time";

import type { ArchiveSink } from "./archive";
import { errorSummary, logEvent } from "./log";
import { pullAll } from "./pull";
import { pushDue } from "./push";
import type { SyncStore, SyncTracker } from "./store";

/**
 * PRD 10.5: close every unclosed day before today, oldest first (a gap of several days after
 * an outage catches up in order). For each day D:
 *   running → forced pull of every active tracker → push until nothing is due → close_day(D)
 *   → queue Knit Note refreshes (N17) → Knit Archive rows for D (10.7) → mismatch check (10.6)
 *   → closed.
 * Any failure marks D failed with the error; the next call (every 15 minutes) starts D again.
 * Every step is idempotent (invariant 8).
 */

export interface CloseDeps {
  store: SyncStore;
  source: SheetSource;
  archive: ArchiveSink;
}

export interface ClosedDay {
  day: LocalDate;
  stats: Record<string, unknown>;
}

/**
 * PRD 10.6: for every active tracker, Knit's status (through writeBack, skipping N8 nulls)
 * against the sheet's status cell. Differences become conflict items and are counted.
 */
export async function mismatchCheck(
  deps: { store: SyncStore; source: SheetSource },
  trackers: SyncTracker[],
): Promise<{ checked: number; mismatches: number }> {
  let checked = 0;
  let mismatches = 0;
  for (const tracker of trackers) {
    const { config } = tracker;
    if (!config.columns.statusWrite) continue;
    const rows = await deps.source.readRows(
      { fileId: tracker.fileId, sheetId: tracker.sheetGid },
      config.headerRow,
    );
    const byId = new Map(
      rows.map((row) => [
        textOf(cellOf(row, KNIT_ID_HEADER)).toLowerCase(),
        row,
      ]),
    );
    const { tasks } = await deps.store.loadPullState(tracker.id);
    for (const task of tasks) {
      if (task.removedAtSource) continue;
      const expected = writeBackFor(task.status, config);
      const row = byId.get(task.id.toLowerCase());
      if (expected === null || !row) continue;
      checked += 1;
      const actual = textOf(cellOf(row, config.columns.statusWrite));
      if (normaliseKey(actual) === normaliseKey(expected)) continue;
      mismatches += 1;
      await deps.store.raiseAttention(
        tracker.id,
        task.id,
        "conflict",
        `conflict:${task.id}`,
        {
          check: "nightly",
          knit: task.status,
          sheet: actual,
        },
      );
    }
  }
  return { checked, mismatches };
}

export async function closeDays(
  deps: CloseDeps,
  options: { deadline?: number; now?: () => number } = {},
): Promise<{
  closed: ClosedDay[];
  failed: { day: LocalDate; error: string } | null;
}> {
  const now = options.now ?? Date.now;
  const timeLeft = () =>
    options.deadline === undefined || now() < options.deadline;
  const { store } = deps;
  const closed: ClosedDay[] = [];

  while (timeLeft()) {
    const day = await store.nextDayToClose();
    if (!day) break;
    try {
      await store.beginDayClosure(day);
      await pullAll(deps, { force: true, deadline: options.deadline, now });
      for (let round = 0; round < 10 && timeLeft(); round += 1) {
        if ((await store.outboxDueCount()) === 0) break;
        await pushDue(deps, { deadline: options.deadline, now });
      }
      const closeStats = await store.closeDay(day);
      const { task_ids: taskIds, ...counts } = closeStats;
      const notesQueued = await store.enqueueNoteRefresh(taskIds);
      await deps.archive.replaceDay(day, await store.archiveRows(day));
      const mismatch = await mismatchCheck(deps, await store.trackers());
      const stats = { ...counts, notesQueued, ...mismatch };
      await store.finishDayClosure(day, stats);
      closed.push({ day, stats });
      logEvent("close.day_closed", {
        job: "close",
        day,
        mismatches: mismatch.mismatches,
      });
    } catch (error) {
      const message = errorSummary(error);
      await store.failDayClosure(day, message);
      logEvent("close.day_failed", { job: "close", day, error: message });
      return { closed, failed: { day, error: message } };
    }
  }
  return { closed, failed: null };
}
