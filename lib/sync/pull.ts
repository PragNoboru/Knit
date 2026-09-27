import { calendarFromDays } from "@/lib/domain/calendar";
import { aliasMap } from "@/lib/domain/owners";
import { planPull, type PullPlan } from "@/lib/domain/planPull";
import { isEmptyRow, normaliseRow } from "@/lib/domain/rows";
import {
  KNIT_ID_HEADER,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";

import { ensureKnitIds } from "./identity";
import { errorSummary, logEvent } from "./log";
import type { PullRequest, SyncStore, SyncTracker } from "./store";
import { checkStructure } from "./structure";

/**
 * PRD 10.2: pull one tracker. Skips when the sheet has not changed (unless forced), checks its
 * structure, secures Knit IDs, normalises rows, plans and applies. A plan that went stale
 * (state_version moved, or midnight passed) is recomputed, up to three times. Running it twice
 * gives the same result (invariant 8).
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

    const readRows = async () =>
      (await source.readRows(ref, config.headerRow)).filter(
        (row) => !isEmptyRow(row, config),
      );
    const identity = await ensureKnitIds(
      source,
      ref,
      config,
      await readRows(),
      (ids) => store.knitIdsElsewhere(tracker.id, ids),
      readRows,
    );
    for (const item of identity.attention) {
      await store.raiseAttention(
        tracker.id,
        null,
        item.kind,
        item.dedupeKey,
        item.detail,
      );
    }

    const context = await store.loadContext();
    const calendar = calendarFromDays(context.calendar);
    const aliases = aliasMap(context.aliases);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
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
      const state = await store.loadPullState(tracker.id);
      const plan = planPull(state.tasks, rows, {
        trackerId: tracker.id,
        goLiveDate: tracker.goLiveDate,
        today,
        config,
      });
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
        const stats = {
          ...plan.stats,
          idsWritten: identity.written,
          idsCleared: identity.cleared,
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
          idsWritten: identity.written,
          idsCleared: identity.cleared,
        };
      }
    }
    await store.finishRun(
      runId,
      false,
      { outcome: "stale" },
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
