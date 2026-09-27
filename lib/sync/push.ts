import {
  normaliseKey,
  TrackerConfig,
  type KnitStatus,
} from "@/lib/domain/config";
import {
  normaliseDateText,
  parseDateText,
  type CellValue,
} from "@/lib/domain/dates";
import { renderKnitNote, type NoteTaskDay } from "@/lib/domain/note";
import {
  cellOf,
  textOf,
  type SheetRow,
  type SourceSnapshot,
} from "@/lib/domain/rows";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type CellWrite,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";
import { formatDate, fromSheetsSerial, type LocalDate } from "@/lib/time";

import { errorSummary, logEvent } from "./log";
import type { SyncStore } from "./store";
import { checkStructure } from "./structure";

/**
 * PRD 10.4: the push job writes Knit's changes back to the sheets.
 *   1. Claim due write-backs (newest per task; paused trackers held).
 *   2. Per tracker: read the rows and find each task's row by its Knit ID at write time.
 *   3. Never write to a formula or read-only column (N6).
 *   4. Status word (unless the tracker cannot express it, N8), completed-on cell (value on done,
 *      cleared on revert of a value Knit wrote) and the Knit Note, in one batch.
 *   5. Re-read and verify by Knit ID. Verified: done, with the sheet's values as the new
 *      snapshot. Otherwise retry with backoff. A write that landed on another row (rows sorted
 *      mid-push) is undone from the values read just before.
 */

export interface ClaimedWrite {
  outboxId: string;
  payload: {
    status_value?: string | null;
    completed_on?: string | null;
    note_only?: boolean;
  };
  attempts: number;
  tracker: {
    id: string;
    fileId: string;
    sheetGid: number | string;
    config: unknown;
  };
  task: {
    id: string;
    status: KnitStatus;
    statusReason: string | null;
    completedOn: LocalDate | null;
    dueDate: LocalDate | null;
    historyOnly: boolean;
    sourceSnapshot: SourceSnapshot | null;
  };
  taskDays: NoteTaskDay[];
}

export interface PushStats {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}

const idOf = (row: SheetRow) =>
  textOf(cellOf(row, KNIT_ID_HEADER)).toLowerCase();

function dateOf(cell: CellValue, today: LocalDate): LocalDate | null {
  if (typeof cell.value === "number") return fromSheetsSerial(cell.value);
  const parsed = parseDateText(normaliseDateText(textOf(cell)), today);
  return parsed.kind === "single" ? parsed.start : null;
}

/** The cells to write for one claimed write-back. */
export function cellsFor(
  item: ClaimedWrite,
  config: TrackerConfig,
  row: number,
  today: LocalDate,
): CellWrite[] {
  const cells: CellWrite[] = [];
  const noteOnly = item.payload.note_only === true;
  const statusValue = item.payload.status_value;
  if (
    !noteOnly &&
    config.columns.statusWrite &&
    statusValue !== null &&
    statusValue !== undefined
  ) {
    cells.push({
      row,
      header: config.columns.statusWrite,
      kind: "text",
      value: statusValue,
    });
  }
  const format = config.completedOnFormat;
  if (!noteOnly && config.columns.completedOn && format) {
    const completedOn = item.payload.completed_on ?? null;
    if (completedOn) {
      cells.push(
        format.type === "date"
          ? {
              row,
              header: config.columns.completedOn,
              kind: "date",
              value: completedOn,
            }
          : {
              row,
              header: config.columns.completedOn,
              kind: "text",
              value: formatDate(completedOn, format.pattern),
            },
      );
    } else if (item.task.sourceSnapshot?.completedOn) {
      // Reverted from Done: clear the value Knit wrote (never a value Knit did not write).
      cells.push({
        row,
        header: config.columns.completedOn,
        kind: "text",
        value: "",
      });
    }
  }
  const note = renderKnitNote(item.task, item.taskDays, today);
  cells.push({ row, header: KNIT_NOTE_HEADER, kind: "text", value: note });
  return cells;
}

function holds(row: SheetRow, cell: CellWrite, today: LocalDate): boolean {
  const actual = cellOf(row, cell.header);
  if (cell.value === "") return textOf(actual) === "";
  if (cell.kind === "date") return dateOf(actual, today) === cell.value;
  return textOf(actual) === cell.value.trim();
}

function snapshotOf(
  row: SheetRow,
  config: TrackerConfig,
  today: LocalDate,
): SourceSnapshot {
  return {
    statusKey: normaliseKey(textOf(cellOf(row, config.columns.statusRead))),
    completedOn: config.columns.completedOn
      ? dateOf(cellOf(row, config.columns.completedOn), today)
      : null,
  };
}

async function pushTracker(
  deps: { store: SyncStore; source: SheetSource },
  items: ClaimedWrite[],
  today: LocalDate,
  stats: PushStats,
): Promise<void> {
  const { store, source } = deps;
  const first = items[0]!;
  const config = TrackerConfig.parse(first.tracker.config);
  const ref: TabRef = {
    fileId: first.tracker.fileId,
    sheetId: Number(first.tracker.sheetGid),
  };
  const settled = new Set<string>();
  const settle = async (
    item: ClaimedWrite,
    ok: boolean,
    snapshot: SourceSnapshot | null,
    error: string | null,
    statusRaw: string | null = null,
  ) => {
    settled.add(item.outboxId);
    await store.pushResult(item.outboxId, ok, snapshot, error, statusRaw);
    if (ok) stats.done += 1;
    else if (
      error === "row_not_found" ||
      error === "formula_column" ||
      item.attempts + 1 >= 5
    )
      stats.failed += 1;
    else stats.retried += 1;
  };

  try {
    const structure = await source.readStructure(ref, config.headerRow);
    // 14: a column missing or doubled (a mapped header, Knit ID, Knit Note) pauses the tracker,
    // as the pull would. The claimed write-backs are left unsettled, so push_claim holds them
    // until it resumes (10.4 step 1). A formula write target fails the row instead (step 3).
    const problem = checkStructure(structure, config);
    if (problem && problem.kind !== "formula_column") {
      await store.pauseTracker(
        first.tracker.id,
        problem.reason,
        problem.kind,
        problem.dedupeKey,
        problem.detail,
      );
      logEvent("push.paused", {
        job: "push",
        tracker: first.tracker.id,
        kind: problem.kind,
      });
      return;
    }
    const writable = new Set(structure.headers.map((h) => h.normalised));
    for (const blocked of [
      ...structure.formulaColumns,
      ...config.readOnlyColumns.map(normaliseKey),
    ]) {
      writable.delete(blocked);
    }
    const before = await source.readRows(ref, config.headerRow);
    const rowOfTask = new Map(before.map((row) => [idOf(row), row]));

    const planned: { item: ClaimedWrite; cells: CellWrite[] }[] = [];
    for (const item of items) {
      const row = rowOfTask.get(item.task.id.toLowerCase());
      if (!row) {
        await settle(item, false, null, "row_not_found");
        continue;
      }
      const cells = cellsFor(item, config, row.rowNumber, today);
      if (cells.some((cell) => !writable.has(normaliseKey(cell.header)))) {
        await settle(item, false, null, "formula_column");
        continue;
      }
      planned.push({ item, cells });
    }
    if (planned.length === 0) return;

    await source.writeCells(
      ref,
      config.headerRow,
      planned.flatMap((p) => p.cells),
    );
    const after = await source.readRows(ref, config.headerRow);
    const afterById = new Map(after.map((row) => [idOf(row), row]));
    const afterByNumber = new Map(after.map((row) => [row.rowNumber, row]));
    const beforeById = new Map(before.map((row) => [idOf(row), row]));

    const repairs: CellWrite[] = [];
    for (const { item, cells } of planned) {
      const row = afterById.get(item.task.id.toLowerCase());
      if (row && cells.every((cell) => holds(row, cell, today))) {
        const statusRaw = textOf(cellOf(row, config.columns.statusRead));
        await settle(
          item,
          true,
          snapshotOf(row, config, today),
          null,
          statusRaw,
        );
        continue;
      }
      // Rows moved between reading and writing: undo the write on whichever row got it.
      for (const cell of cells) {
        const landed = afterByNumber.get(cell.row);
        const landedId = landed ? idOf(landed) : "";
        if (!landed || landedId === item.task.id.toLowerCase()) continue;
        const original = beforeById.get(landedId);
        if (original && holds(landed, cell, today)) {
          repairs.push({
            row: cell.row,
            header: cell.header,
            kind: "text",
            value: textOf(cellOf(original, cell.header)),
          });
        }
      }
      await settle(item, false, null, "verify_mismatch");
    }
    if (repairs.length > 0) {
      await source.writeCells(ref, config.headerRow, repairs);
      logEvent("push.repaired", {
        job: "push",
        tracker: first.tracker.id,
        cells: repairs.length,
      });
    }
  } catch (error) {
    const message = errorSummary(error);
    logEvent("push.tracker_failed", {
      job: "push",
      tracker: first.tracker.id,
      error: message,
    });
    for (const item of items)
      if (!settled.has(item.outboxId)) await settle(item, false, null, message);
  }
}

/** Pushes due write-backs (all, or one task's for the immediate push after a change, 7.3). */
export async function pushDue(
  deps: { store: SyncStore; source: SheetSource },
  options: {
    taskId?: string;
    limit?: number;
    deadline?: number;
    now?: () => number;
  } = {},
): Promise<PushStats> {
  const now = options.now ?? Date.now;
  const today = await deps.store.today();
  const claimed = (await deps.store.pushClaim(
    options.limit ?? 200,
    options.taskId ?? null,
  )) as ClaimedWrite[];
  const stats: PushStats = {
    claimed: claimed.length,
    done: 0,
    retried: 0,
    failed: 0,
  };
  const byTracker = new Map<string, ClaimedWrite[]>();
  for (const item of claimed) {
    byTracker.set(item.tracker.id, [
      ...(byTracker.get(item.tracker.id) ?? []),
      item,
    ]);
  }
  for (const items of byTracker.values()) {
    // Unfinished claims are simply due again after their two-minute claim (invariant 8).
    if (options.deadline !== undefined && now() >= options.deadline) break;
    await pushTracker(deps, items, today, stats);
  }
  if (stats.claimed > 0) logEvent("push.done", { job: "push", ...stats });
  return stats;
}
