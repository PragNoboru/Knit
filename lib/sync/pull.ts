import { calendarFromDays } from "@/lib/domain/calendar";
import type { TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { planPull, type PlanTask, type PullPlan } from "@/lib/domain/planPull";
import { normaliseRow, type NormalisedRow } from "@/lib/domain/rows";
import { heldSourceStatus } from "@/lib/domain/status";
import {
  KNIT_ID_HEADER,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";

import { ensureKnitIds, rowsWithContent } from "./identity";
import { errorSummary, logEvent } from "./log";
import type { PullRequest, SyncStore, SyncTracker } from "./store";
import { checkStructure } from "./structure";

/**
 * PRD 10.2: pull one tracker. Skips when the sheet has not changed (unless forced), checks its
 * structure, secures Knit IDs, normalises rows, plans and applies. A plan that went stale
 * (state_version moved, or midnight passed) is recomputed, up to three times. Running it twice
 * gives the same result (invariant 8).
 *
 * Knit's state is loaded before the rows are read, and the rows are read again on every
 * attempt, so the rows are never older than the state they are merged with: a write-back that
 * lands while the pull runs is either in the rows it reads, or still counts as a change made in
 * Knit (10.3), and is never mistaken for a change in the sheet.
 */

export interface PullDeps {
  store: SyncStore;
  source: SheetSource;
}

export type PullOutcome =
  | { tracker: string; outcome: "skipped" }
  | { tracker: string; outcome: "paused"; reason: string }
  | {
      tracker: string;
      outcome: "pulled";
      stats: PullPlan["stats"];
      idsWritten: number;
      idsCleared: number;
    }
  | { tracker: string; outcome: "stale" }
  | { tracker: string; outcome: "failed"; error: string };

const MAX_ATTEMPTS = 3;

function sameInstant(a: string | null, b: string | null): boolean {
  return (
    a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime()
  );
}

/**
 * 10.3, 15: a conflict needs the sheet to disagree with Knit. When Knit's own write-back is
 * already in the sheet but its push has not recorded it yet (the pull ran between the write
 * and push_result, or the push was stopped there), the sheet says what Knit says: no conflict
 * item. The write-back still goes out (the plan keeps it) and records the snapshot.
 */
export function withoutSelfConflicts(
  plan: PullPlan,
  tasks: readonly PlanTask[],
  rows: readonly NormalisedRow[],
  config: TrackerConfig,
): PullPlan {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const rowById = new Map(rows.map((row) => [row.knitId, row]));
  const agrees = (taskId: string | null) => {
    const task = taskId ? taskById.get(taskId) : undefined;
    const row = taskId ? rowById.get(taskId) : undefined;
    if (task === undefined || row === undefined) return false;
    // N28: a word the row still shows reads as the status recorded with it.
    const read = heldSourceStatus(row.status, task.sourceSnapshot, config);
    return (
      task.hubChanged &&
      read.mapped &&
      read.status === task.status &&
      (!config.columns.completedOn ||
        row.snapshot.completedOn === task.completedOn)
    );
  };
  const dropped = plan.attention.filter(
    (item) =>
      item.kind === "conflict" &&
      item.detail.reason === undefined &&
      agrees(item.taskId),
  );
  if (dropped.length === 0) return plan;
  return {
    ...plan,
    attention: plan.attention.filter((item) => !dropped.includes(item)),
    stats: {
      ...plan.stats,
      conflicts: plan.stats.conflicts - dropped.length,
    },
  };
}

export async function pullTracker(
  deps: PullDeps,
  tracker: SyncTracker,
  options: {
    force?: boolean;
    /** The tracker's owed pulls, read before `tracker` was loaded (see pullAll). */
    request?: PullRequest;
  } = {},
): Promise<PullOutcome> {
  const { store, source } = deps;
  const { config } = tracker;
  const ref: TabRef = { fileId: tracker.fileId, sheetId: tracker.sheetGid };
  const { request } = options;
  // 11, N19(d), 12.8: a config, alias or calendar change is owed a pull, sheet changed or not.
  const owed = request !== undefined && request.requested > request.served;
  const runId = await store.startRun("pull", tracker.id);
  try {
    // Captured before reading, so an edit made while we read is picked up by the next pull.
    const modifiedTime = await source.getFileModifiedTime(tracker.fileId);
    if (
      !options.force &&
      !owed &&
      sameInstant(modifiedTime, tracker.lastSourceModifiedTime)
    ) {
      await store.finishRun(runId, true, { outcome: "skipped" });
      return { tracker: tracker.id, outcome: "skipped" };
    }

    const problem = checkStructure(
      await source.readStructure(ref, config.headerRow),
      config,
    );
    if (problem) {
      await store.pauseTracker(
        tracker.id,
        problem.reason,
        problem.kind,
        problem.dedupeKey,
        problem.detail,
      );
      await store.finishRun(
        runId,
        false,
        { outcome: "paused", kind: problem.kind },
        problem.reason,
      );
      logEvent("pull.paused", {
        job: "pull",
        tracker: tracker.id,
        run: runId,
        kind: problem.kind,
      });
      return { tracker: tracker.id, outcome: "paused", reason: problem.reason };
    }

    // 7.4: tabs are found by gid, so a renamed tab keeps syncing; its new name is picked up.
    // Only the name shown on the admin screens depends on it, so it never stops a pull.
    try {
      const tab = (await source.listTabs(tracker.fileId)).find(
        (t) => t.sheetId === tracker.sheetGid,
      );
      if (tab && tab.title !== tracker.tabName) {
        await store.recordTabName(tracker.id, tab.title);
      }
    } catch (error) {
      logEvent("pull.tab_name_failed", {
        job: "pull",
        tracker: tracker.id,
        run: runId,
        error: errorSummary(error),
      });
    }

    const context = await store.loadContext();
    const calendar = calendarFromDays(context.calendar);
    const aliases = aliasMap(context.aliases);
    // 10.2 step 3: rows empty in every mapped column are ignored.
    const readRows = async () =>
      rowsWithContent(await source.readRows(ref, config.headerRow), config);
    let idsWritten = 0;
    let idsCleared = 0;
    let idsRestored = 0;
    // N59: new Knit IDs confirmed on rows that came back, across attempts (a new ID written in
    // one attempt is an ordinary new row in the next).
    const returned = new Set<string>();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const state = await store.loadPullState(tracker.id);
      // N30, N59: the Knit IDs of tasks removed at source, from the state this attempt applies to.
      const retired = new Set(
        state.tasks
          .filter((task) => task.removedAtSource)
          .map((task) => task.id.toLowerCase()),
      );
      const identity = await ensureKnitIds(
        source,
        ref,
        config,
        await readRows(),
        (ids) => store.knitIdsElsewhere(tracker.id, ids),
        readRows,
        retired,
        // N59, invariant 8: recorded before the write, so the note refresh is queued by
        // whichever pull saves the new task, even if this run stops first.
        (ids) => store.recordReturnedRows(tracker.id, ids),
      );
      idsWritten += identity.written;
      idsCleared += identity.cleared;
      idsRestored += identity.restored;
      for (const id of identity.returned) returned.add(id);
      for (const item of identity.attention) {
        await store.raiseAttention(
          tracker.id,
          null,
          item.kind,
          item.dedupeKey,
          item.detail,
        );
      }
      if (identity.unstable) {
        // Invariant 7: a Knit ID was overwritten while rows moved and could not be put back.
        // These rows would count its task as removed, so nothing is applied this time.
        await store.finishRun(
          runId,
          false,
          {
            outcome: "stale",
            idsWritten,
            idsCleared,
            idsRestored,
            rowsReturned: returned.size,
          },
          "rows moved while Knit IDs were written",
        );
        logEvent("pull.unstable", {
          job: "pull",
          tracker: tracker.id,
          run: runId,
        });
        return { tracker: tracker.id, outcome: "stale" };
      }

      const today = await store.today();
      const rows = identity.rows.map((row) =>
        normaliseRow(row, {
          config,
          calendar,
          aliases,
          trackerOwnerId: tracker.ownerUserId,
          today,
          knitIdHeader: KNIT_ID_HEADER,
        }),
      );
      const plan = withoutSelfConflicts(
        planPull(state.tasks, rows, {
          trackerId: tracker.id,
          goLiveDate: tracker.goLiveDate,
          today,
          config,
        }),
        state.tasks,
        rows,
        config,
      );
      const applied = await store.applyPullPlan(
        tracker.id,
        state.stateVersion,
        plan,
        runId,
        modifiedTime,
      );
      if (applied.result === "applied") {
        // The requests read before this pull loaded its inputs are served; a later one stays.
        if (request) await store.markPullServed(tracker.id, request.requested);
        // N59, N17: the Knit Note of a row that came back still describes the removed task.
        // Every returning row recorded so far whose new task is now saved (by this pull or, when
        // its date was unreadable or an earlier run stopped, a later one) gets its note
        // refresh. Best effort: the plan is applied, so a failure never fails the run; the
        // recorded rows wait for the next applied pull.
        try {
          await store.refreshReturnedRows(tracker.id);
        } catch (error) {
          logEvent("pull.note_refresh_failed", {
            job: "pull",
            tracker: tracker.id,
            run: runId,
            error: errorSummary(error),
          });
        }
        const stats = {
          ...plan.stats,
          idsWritten,
          idsCleared,
          idsRestored,
          rowsReturned: returned.size,
        };
        await store.finishRun(runId, true, { outcome: "pulled", ...stats });
        logEvent("pull.done", {
          job: "pull",
          tracker: tracker.id,
          run: runId,
          ...stats,
        });
        return {
          tracker: tracker.id,
          outcome: "pulled",
          stats: plan.stats,
          idsWritten,
          idsCleared,
        };
      }
    }
    await store.finishRun(
      runId,
      false,
      {
        outcome: "stale",
        idsWritten,
        idsCleared,
        idsRestored,
        rowsReturned: returned.size,
      },
      "plan went stale three times",
    );
    logEvent("pull.stale", { job: "pull", tracker: tracker.id, run: runId });
    return { tracker: tracker.id, outcome: "stale" };
  } catch (error) {
    const message = errorSummary(error);
    await store.finishRun(runId, false, { outcome: "failed" }, message);
    logEvent("pull.failed", {
      job: "pull",
      tracker: tracker.id,
      run: runId,
      error: message,
    });
    return { tracker: tracker.id, outcome: "failed", error: message };
  }
}

/** Pulls every active tracker (or the given ones) while the time budget lasts (7.3). */
export async function pullAll(
  deps: PullDeps,
  options: {
    force?: boolean;
    trackerIds?: string[];
    deadline?: number;
    now?: () => number;
  } = {},
): Promise<PullOutcome[]> {
  const now = options.now ?? Date.now;
  // Read before the trackers and their configs: a change saved after this read stays owed,
  // even when this pull goes on to load the new config (11, N19 d, 12.8).
  const requests = await deps.store.pullRequests(options.trackerIds);
  const trackers = await deps.store.trackers({ ids: options.trackerIds });
  const outcomes: PullOutcome[] = [];
  for (const tracker of trackers) {
    if (options.deadline !== undefined && now() >= options.deadline) break;
    outcomes.push(
      await pullTracker(deps, tracker, {
        force: options.force,
        request: requests[tracker.id],
      }),
    );
  }
  return outcomes;
}
