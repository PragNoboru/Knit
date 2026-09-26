import type { CalendarDay } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import type { PlanTask, PullPlan } from "@/lib/domain/planPull";
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
