import { normaliseKey } from "@/lib/domain/config";
import { cellOf, textOf } from "@/lib/domain/rows";
import {
  heldSourceStatus,
  mapSourceStatus,
  writeBackFor,
} from "@/lib/domain/status";
import type { SheetSource } from "@/lib/sheets/types";
import type { LocalDate } from "@/lib/time";

import type { ArchiveSink } from "./archive";
import { rowsByKnitId, rowsWithContent } from "./identity";
import { withLease, type LeaseOptions } from "./leases";
import { errorSummary, logEvent } from "./log";
import { pullTracker } from "./pull";
import { pushDue } from "./push";
import type { SyncStore, SyncTracker } from "./store";

/**
 * PRD 10.5: close every unclosed day before today, oldest first (a gap of several days after
 * an outage catches up in order). For each day D:
 *   running → forced pull of every active tracker → push until nothing is due → close_day(D)
 *   (which also queues the Knit Note refreshes, N17) → Knit Archive rows for D (10.7) →
 *   mismatch check (10.6) → closed.
 * The forced pull runs under the pull lease and the push under the push lease, like every
 * other pull and push (7.3, 14). D is closed only on a complete forced pull: a tracker whose
 * pull failed or went stale marks D failed with the error, and the next call (every 15
 * minutes) starts D again (10.5 step 3). When a lease stays taken or the time budget runs out,
 * D waits for the next call. Trackers already pulled for D are not pulled again, so a close
 * that needs several calls always gets there. Every step is idempotent (invariant 8).
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

export interface CloseOptions {
  deadline?: number;
  now?: () => number;
  /** How long to wait for a pull or push lease another job holds (7.3). */
  leaseWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CloseResult {
  closed: ClosedDay[];
  failed: { day: LocalDate; error: string } | null;
  /** A day left for the next call without failing it: a lease was taken, or time ran out. */
  waiting?: { day: LocalDate; reason: string };
}

/**
 * PRD 10.6: for every active tracker, Knit's status against the sheet's status cell, skipping
 * statuses whose write-back is null (N8). The cell agrees when it holds the write-back word,
 * or a word the tracker's statusMap reads as the same Knit status ("Skipped" is Cancelled,
 * Q4; Noboru "No" is Yet to Start and "Moved" is Cancelled, N5). A word the cell still shows
 * as Knit last read or wrote it reads as the status recorded with it (N28, N34), so a remap
 * alone raises no mismatch. Differences become conflict items and are counted.
 */
export async function mismatchCheck(
  deps: { store: SyncStore; source: SheetSource },
  trackers: SyncTracker[],
): Promise<{ checked: number; mismatches: number }> {
  let checked = 0;
  let mismatches = 0;
  for (const tracker of trackers) {
    const { config } = tracker;
    const statusCell = config.columns.statusWrite;
    if (!statusCell) continue;
    // The rows as the pull sees them (10.2 steps 3 and 4): rows empty in every mapped column
    // are ignored, and a Knit ID on two rows belongs to the upper one.
    const byId = rowsByKnitId(
      rowsWithContent(
        await deps.source.readRows(
          { fileId: tracker.fileId, sheetId: tracker.sheetGid },
          config.headerRow,
        ),
        config,
      ),
    );
    // statusMap reads the status-read column's words; they only apply to the cell Knit writes
    // when both are the same column.
    const readsSameCell =
      normaliseKey(config.columns.statusRead) === normaliseKey(statusCell);
    const { tasks } = await deps.store.loadPullState(tracker.id);
    for (const task of tasks) {
      if (task.removedAtSource) continue;
      const expected = writeBackFor(task.status, config);
      const row = byId.get(task.id.toLowerCase())?.[0];
      if (expected === null || !row) continue;
      checked += 1;
      const actual = textOf(cellOf(row, statusCell));
      if (normaliseKey(actual) === normaliseKey(expected)) continue;
      if (readsSameCell) {
        const read = heldSourceStatus(
          mapSourceStatus(actual, config),
          task.sourceSnapshot,
          config,
        );
        if (read.mapped && read.status === task.status) continue;
      }
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

/** Stops the close of D for this call, leaving it for the next one. Not a failure. */
class Waiting extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function closeDays(
  deps: CloseDeps,
  options: CloseOptions = {},
): Promise<CloseResult> {
  const now = options.now ?? Date.now;
  const { deadline } = options;
  const timeLeft = () => deadline === undefined || now() < deadline;
  const { store } = deps;
  const closed: ClosedDay[] = [];

  // The pull and push leases (7.3): held for at most the rest of this call's budget, and
  // waited for a little when the pull or push job is running.
  const lease = (): LeaseOptions => {
    const remaining = deadline === undefined ? null : deadline - now();
    return {
      ttlSeconds: remaining === null ? 120 : remaining / 1000 + 30,
      waitMs: Math.max(
        0,
        Math.min(options.leaseWaitMs ?? 20_000, remaining ?? Infinity),
      ),
      sleep: options.sleep,
    };
  };

  /** 10.5 step 2: the forced pull of every active tracker not yet pulled for D. */
  const forcedPull = async (day: LocalDate) => {
    const run = await withLease(store, "pull", lease(), async () => {
      const pulled = new Set(await store.closurePulledTrackers(day));
      const failures: string[] = [];
      for (const tracker of await store.trackers()) {
        if (pulled.has(tracker.id)) continue;
        if (!timeLeft()) return { finished: false, failures };
        const outcome = await pullTracker(deps, tracker, { force: true });
        if (outcome.outcome === "pulled") {
          await store.recordClosurePull(day, tracker.id);
        } else if (outcome.outcome === "failed") {
          failures.push(`${tracker.name}: ${outcome.error}`);
        } else if (outcome.outcome !== "paused") {
          // A plan that went stale three times (or a pull that did not run) left the sheet's
          // latest values out of Knit. A paused tracker is no longer active (14).
          failures.push(`${tracker.name}: pull ${outcome.outcome}`);
        }
      }
      return { finished: true, failures };
    });
    if (run.skipped) throw new Waiting("the pull job is running");
    if (run.result.failures.length > 0) {
      throw new Error(
        `Forced pull incomplete: ${run.result.failures.join("; ")}`,
      );
    }
    if (!run.result.finished)
      throw new Waiting("the forced pull continues on the next call");
  };

  /** 10.5 step 2: push until no write-back is due for an active tracker (time-bounded). */
  const pushAll = async () => {
    for (let round = 0; round < 10 && timeLeft(); round += 1) {
      if ((await store.outboxDueCount()) === 0) break;
      const run = await withLease(store, "push", lease(), () =>
        pushDue(deps, { deadline, now }),
      );
      if (run.skipped) throw new Waiting("the push job is running");
    }
  };

  while (timeLeft()) {
    const day = await store.nextDayToClose();
    if (!day) break;
    try {
      await store.beginDayClosure(day);
      await forcedPull(day);
      await pushAll();
      if (!timeLeft()) throw new Waiting("the time budget ran out");
      // close_day queues the Knit Note refreshes in its own transaction and keeps its result,
      // so a retried close still reports the first run's counts (invariant 8).
      const {
        task_ids: touched,
        notes_queued: notesQueued,
        ...counts
      } = await store.closeDay(day);
      if (!timeLeft()) throw new Waiting("the time budget ran out");
      await deps.archive.replaceDay(day, await store.archiveRows(day));
      const mismatch = await mismatchCheck(deps, await store.trackers());
      const stats = { ...counts, notesQueued, ...mismatch };
      await store.finishDayClosure(day, stats);
      closed.push({ day, stats });
      logEvent("close.day_closed", {
        job: "close",
        day,
        tasks: touched.length,
        mismatches: mismatch.mismatches,
      });
    } catch (error) {
      if (error instanceof Waiting) {
        logEvent("close.day_waiting", {
          job: "close",
          day,
          reason: error.reason,
        });
        return { closed, failed: null, waiting: { day, reason: error.reason } };
      }
      const message = errorSummary(error);
      await store.failDayClosure(day, message);
      logEvent("close.day_failed", { job: "close", day, error: message });
      return { closed, failed: { day, error: message } };
    }
  }
  return { closed, failed: null };
}
