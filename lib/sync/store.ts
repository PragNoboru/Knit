import type { CalendarDay } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import type { PlanTask, PullPlan } from "@/lib/domain/planPull";
import type { SourceSnapshot } from "@/lib/domain/rows";
import type { DriveFile } from "@/lib/sheets/types";
import type { LocalDate } from "@/lib/time";

/**
 * The jobs' access to the database: one method per SQL function (supabase/migrations), called
 * through an RPC caller. Production passes supabase-js with the service role; integration tests
 * pass their database session, so the jobs run against the real SQL.
 */

export type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface SyncTracker {
  id: string;
  fileId: string;
  sheetGid: number;
  tabName: string;
  name: string;
  state: string;
  config: TrackerConfig;
  goLiveDate: LocalDate;
  ownerUserId: string | null;
  stateVersion: number;
  lastSourceModifiedTime: string | null;
}

export interface SyncContext {
  calendar: CalendarDay[];
  aliases: { aliasNorm: string; userId: string | null }[];
}

export type ApplyResult =
  { result: "applied"; stats: PullPlan["stats"] } | { result: "retry" };

/** What close_day returns (PRD 6.4, 19). */
export interface CloseDayStats {
  day: LocalDate;
  next_working_day: LocalDate;
  locked_as_is: number;
  not_done: number;
  blocked: number;
  spillovers: number;
  early_completions_locked: number;
  task_ids: string[];
}

export interface SyncStore {
  today(): Promise<LocalDate>;
  loadContext(): Promise<SyncContext>;
  trackers(options?: {
    states?: string[];
    ids?: string[];
  }): Promise<SyncTracker[]>;
  loadPullState(
    trackerId: string,
  ): Promise<{ stateVersion: number; tasks: PlanTask[] }>;
  knitIdsElsewhere(trackerId: string, ids: string[]): Promise<string[]>;
  /** PRD 7.4: the tab's current name, picked up by the pull (tabs are found by gid). */
  recordTabName(trackerId: string, tabName: string): Promise<void>;
  applyPullPlan(
    trackerId: string,
    expectedStateVersion: number,
    plan: PullPlan,
    runId: number | null,
    sourceModifiedTime: string | null,
  ): Promise<ApplyResult>;
  recordDriveListing(
    files: DriveFile[],
  ): Promise<{ listed: number; new: number; left: number; paused: number }>;
  pauseTracker(
    trackerId: string,
    reason: string,
    kind: string,
    dedupeKey: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
  raiseAttention(
    trackerId: string | null,
    taskId: string | null,
    kind: string,
    dedupeKey: string,
    detail: Record<string, unknown>,
  ): Promise<void>;
  /** PRD 10.4: claims due write-backs (see push_claim). */
  pushClaim(limit: number, taskId: string | null): Promise<unknown[]>;
  /** 10.4 step 5. `snapshot` holds only the mapped cells the push wrote (10.3). */
  pushResult(
    outboxId: string,
    ok: boolean,
    snapshot: Partial<SourceSnapshot> | null,
    error: string | null,
    statusRaw?: string | null,
  ): Promise<void>;
  /** PRD 10.5: the close-days job. */
  nextDayToClose(): Promise<LocalDate | null>;
  beginDayClosure(day: LocalDate): Promise<void>;
  finishDayClosure(
    day: LocalDate,
    stats: Record<string, unknown>,
  ): Promise<void>;
  failDayClosure(day: LocalDate, error: string): Promise<void>;
  closeDay(day: LocalDate): Promise<CloseDayStats>;
  enqueueNoteRefresh(taskIds: string[]): Promise<number>;
  archiveRows(
    day: LocalDate,
  ): Promise<{ taskDays: unknown[][]; events: unknown[][] }>;
  outboxDueCount(): Promise<number>;
  /** PRD 7.3: the holder id, or null when another call holds the job's lease. */
  acquireLease(job: string, ttlSeconds: number): Promise<string | null>;
  releaseLease(job: string, holder: string): Promise<boolean>;
  startRun(job: string, trackerId?: string | null): Promise<number>;
  finishRun(
    id: number,
    ok: boolean,
    stats: Record<string, unknown>,
    error?: string | null,
  ): Promise<void>;
}

interface RawTracker extends Omit<
  SyncTracker,
  "config" | "stateVersion" | "sheetGid"
> {
  config: unknown;
  stateVersion: number | string;
  sheetGid: number | string;
}

export function createSyncStore(rpc: Rpc): SyncStore {
  return {
    today: async () => String(await rpc("knit_today", {})),
    loadContext: async () =>
      (await rpc("load_sync_context", {})) as SyncContext,
    trackers: async (options = {}) => {
      const raw = (await rpc("sync_trackers", {
        p_states: options.states ?? null,
        p_ids: options.ids ?? null,
      })) as RawTracker[];
      return raw.map((t) => ({
        ...t,
        sheetGid: Number(t.sheetGid),
        stateVersion: Number(t.stateVersion),
        config: TrackerConfig.parse(t.config),
      }));
    },
    loadPullState: async (trackerId) => {
      const state = (await rpc("load_pull_state", {
        p_tracker_id: trackerId,
      })) as {
        stateVersion: number | string;
        tasks: PlanTask[];
      };
      return { stateVersion: Number(state.stateVersion), tasks: state.tasks };
    },
    knitIdsElsewhere: async (trackerId, ids) =>
      ids.length === 0
        ? []
        : ((await rpc("knit_ids_elsewhere", {
            p_tracker_id: trackerId,
            p_ids: ids,
          })) as string[]),
    recordTabName: async (trackerId, tabName) => {
      await rpc("record_tab_name", {
        p_tracker_id: trackerId,
        p_tab_name: tabName,
      });
    },
    applyPullPlan: async (
      trackerId,
      expectedStateVersion,
      plan,
      runId,
      sourceModifiedTime,
    ) =>
      (await rpc("apply_pull_plan", {
        p_tracker_id: trackerId,
        p_expected_state_version: expectedStateVersion,
        p_plan: plan,
        p_run_id: runId,
        p_source_modified_time: sourceModifiedTime,
      })) as ApplyResult,
    recordDriveListing: async (files) =>
      (await rpc("record_drive_listing", { p_files: files })) as {
        listed: number;
        new: number;
        left: number;
        paused: number;
      },
    pauseTracker: async (trackerId, reason, kind, dedupeKey, detail) => {
      await rpc("pause_tracker", {
        p_tracker_id: trackerId,
        p_reason: reason,
        p_kind: kind,
        p_dedupe_key: dedupeKey,
        p_detail: detail,
      });
    },
    raiseAttention: async (trackerId, taskId, kind, dedupeKey, detail) => {
      await rpc("raise_attention", {
        p_tracker_id: trackerId,
        p_task_id: taskId,
        p_kind: kind,
        p_dedupe_key: dedupeKey,
        p_detail: detail,
      });
    },
    pushClaim: async (limit, taskId) =>
      (await rpc("push_claim", {
        p_limit: limit,
        p_task_id: taskId,
      })) as unknown[],
    pushResult: async (outboxId, ok, snapshot, error, statusRaw = null) => {
      await rpc("push_result", {
        p_outbox_id: outboxId,
        p_ok: ok,
        p_snapshot: snapshot,
        p_error: error,
        p_status_raw: statusRaw,
      });
    },
    nextDayToClose: async () => {
      const day = await rpc("next_day_to_close", {});
      return day === null || day === undefined ? null : String(day);
    },
    beginDayClosure: async (day) => {
      await rpc("begin_day_closure", { p_day: day });
    },
    finishDayClosure: async (day, stats) => {
      await rpc("finish_day_closure", { p_day: day, p_stats: stats });
    },
    failDayClosure: async (day, error) => {
      await rpc("fail_day_closure", { p_day: day, p_error: error });
    },
    closeDay: async (day) =>
      (await rpc("close_day", { p_day: day })) as CloseDayStats,
    enqueueNoteRefresh: async (taskIds) =>
      taskIds.length === 0
        ? 0
        : Number(await rpc("enqueue_note_refresh", { p_task_ids: taskIds })),
    archiveRows: async (day) =>
      (await rpc("archive_rows", { p_day: day })) as {
        taskDays: unknown[][];
        events: unknown[][];
      },
    outboxDueCount: async () => Number(await rpc("outbox_due_count", {})),
    acquireLease: async (job, ttlSeconds) => {
      const holder = await rpc("acquire_lease", {
        p_job: job,
        p_ttl_seconds: ttlSeconds,
      });
      return holder === null || holder === undefined ? null : String(holder);
    },
    releaseLease: async (job, holder) =>
      Boolean(await rpc("release_lease", { p_job: job, p_holder: holder })),
    startRun: async (job, trackerId = null) =>
      Number(
        await rpc("start_sync_run", { p_job: job, p_tracker_id: trackerId }),
      ),
    finishRun: async (id, ok, stats, error = null) => {
      await rpc("finish_sync_run", {
        p_id: id,
        p_ok: ok,
        p_stats: stats,
        p_error: error,
      });
    },
  };
}
