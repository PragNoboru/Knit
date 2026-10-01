import {
  normaliseKey,
  type KnitStatus,
  type TrackerConfig,
  type UserStatus,
} from "./config";
import type { SourceSnapshot } from "./rows";

/** PRD 6.1: labels shown for each status. The UI always pairs them with an icon (12.2). */
export const STATUS_LABELS: Record<KnitStatus, string> = {
  yet_to_start: "Yet to Start",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
  not_done: "Not Done",
};

/** D2: Blocked and Cancelled need a one-line reason of at most 140 characters. */
export const REASON_MAX_LENGTH = 140;

export function needsReason(status: UserStatus): boolean {
  return status === "blocked" || status === "cancelled";
}

export function isFinal(status: KnitStatus): boolean {
  return status === "done" || status === "cancelled";
}

export interface SourceStatus {
  status: UserStatus;
  /** False when the word is not in statusMap: treated as Yet to Start, never Done (6.8). */
  mapped: boolean;
  /** The raw word, normalised, as used for statusMap lookups and Needs Attention items. */
  key: string;
  /** Reason for words mapped to Cancelled, from cancelReasons (Noboru "moved"). */
  cancelReason: string | null;
}

/** PRD 6.8: maps a source status word to a Knit status. */
export function mapSourceStatus(
  raw: string | null | undefined,
  config: TrackerConfig,
): SourceStatus {
  const key = normaliseKey(raw ?? "");
  const status = config.statusMap[key];
  if (status === undefined) {
    return { status: "yet_to_start", mapped: false, key, cancelReason: null };
  }
  return {
    status,
    mapped: true,
    key,
    cancelReason:
      status === "cancelled" ? (config.cancelReasons[key] ?? null) : null,
  };
}

/**
 * N28: how the pull and the checks read a row's status word. While the row shows the word Knit
 * last read or wrote (source_snapshot), it stands for the Knit status recorded with it, not
 * for what the current status map says, so a remapped word changes no existing task. The
 * current map applies to a word that differs from the snapshot, to a word recorded as unmapped
 * (null, N60), and when there is no snapshot or it predates the recorded status. A held
 * Cancelled takes its word's configured reason when there is one. Type-only import of rows.ts:
 * rows.ts imports this module at runtime.
 */
export function heldSourceStatus(
  read: SourceStatus,
  snapshot: SourceSnapshot | null,
  config: TrackerConfig,
): SourceStatus {
  if (
    snapshot === null ||
    snapshot.statusKey !== read.key ||
    snapshot.status === undefined ||
    snapshot.status === null
  ) {
    return read;
  }
  const status = snapshot.status;
  return {
    status,
    mapped: true,
    key: read.key,
    cancelReason:
      status === "cancelled" ? (config.cancelReasons[read.key] ?? null) : null,
  };
}

/** PRD 6.8, N8: the word to write for a status; "" clears the cell, null leaves it alone. */
export function writeBackFor(
  status: UserStatus,
  config: TrackerConfig,
): string | null {
  return config.writeBack[status];
}
