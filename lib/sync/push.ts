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
import { mapSourceStatus } from "@/lib/domain/status";
import {
  cellOf,
  textOf,
  type SheetRow,
  type SourceSnapshot,
} from "@/lib/domain/rows";
import {
  KNIT_NOTE_HEADER,
  type CellWrite,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";
import { formatDate, fromSheetsSerial, type LocalDate } from "@/lib/time";

import { knitIdOf, rowsByKnitId, rowsWithContent } from "./identity";
import { errorSummary, logEvent } from "./log";
import type { SyncStore } from "./store";
import { checkStructure } from "./structure";

/**
 * PRD 10.4: the push job writes Knit's changes back to the sheets.
 *   1. Claim due write-backs (newest per task; paused trackers held).
 *   2. Per tracker: read the rows and find each task's row by its Knit ID at write time. A
 *      Knit ID found on two rows (a pasted copy, 14) is not guessed at: nothing is written and
 *      the write-back is retried, never failed for good (N22), after the next pull has given
 *      the lower row a new ID. Rows empty in every mapped column do not count, as for the pull
 *      (10.2 step 3), so a Knit ID left on a cleared row never blocks the write. A task removed
 *      at source (when claimed, or by a pull before this push read the rows) fails with
 *      row_not_found without its row being looked for (N11, N59): a row put back after its
 *      removal is a new task (N30), never the removed task's row.
 *   3. Never write to a formula or read-only column (N6).
 *   4. Status word (unless the tracker cannot express it, N8), completed-on cell (value on done,
 *      cleared on a revert from the Done the sheet shows) and the Knit Note, in one batch.
 *   5. Re-read and verify by Knit ID. Verified: done, and the cells Knit wrote (only those)
 *      become the new snapshot (10.3). Otherwise retry with backoff. A write that landed on
 *      another row (rows sorted mid-push) is undone from the values read just before; when that
 *      row cannot be named by its Knit ID, its value cannot be put back exactly, or the sheet
 *      cannot be read back at all, attention write_misplaced says which rows to check.
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
    /** N59: the task was removed at source; its write-backs fail with row_not_found. */
    removedAtSource: boolean;
  };
  taskDays: NoteTaskDay[];
}

export interface PushStats {
  claimed: number;
  done: number;
  retried: number;
  failed: number;
}

function dateOf(cell: CellValue, today: LocalDate): LocalDate | null {
  if (typeof cell.value === "number") return fromSheetsSerial(cell.value);
  const parsed = parseDateText(normaliseDateText(textOf(cell)), today);
  return parsed.kind === "single" ? parsed.start : null;
}

const sameHeader = (a: string, b: string | null) =>
  b !== null && normaliseKey(a) === normaliseKey(b);

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
    const shown = item.task.sourceSnapshot;
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
    } else if (
      shown?.completedOn &&
      config.statusMap[shown.statusKey] === "done"
    ) {
      // 10.4 step 4: a revert from the Done the sheet shows clears its completed-on value. A
      // date beside any other status (typed by a person) is not Knit's to clear.
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

/**
 * 10.3: what a verified write puts in source_snapshot: exactly the mapped cells Knit wrote,
 * re-read from the sheet, and nothing it did not write (a note-only write-back, or a status the
 * tracker cannot express, N8, leaves the other values as the last pull saw them). Null when it
 * wrote neither cell. push_result merges it into the task's snapshot.
 *
 * The status word is read from the status-read column (as the pull reads it). It is Knit's own
 * write only when that column is the status-write column, or a formula column (N6) computed
 * from it, like Noboru's Status (6.8). Any other status-read column is a cell Knit did not
 * write: its last pulled word stays, so a word a person typed there is still seen by the next
 * pull (N23). `formulaColumns` are the tab's normalised formula headers (TabStructure).
 */
export function writtenSnapshot(
  row: SheetRow,
  cells: readonly CellWrite[],
  config: TrackerConfig,
  today: LocalDate,
  formulaColumns: readonly string[] = [],
): Partial<SourceSnapshot> | null {
  const wrote = (header: string | null) =>
    cells.some((cell) => sameHeader(cell.header, header));
  const readFollowsWrite =
    sameHeader(config.columns.statusRead, config.columns.statusWrite) ||
    formulaColumns.includes(normaliseKey(config.columns.statusRead));
  const snapshot: Partial<SourceSnapshot> = {};
  if (wrote(config.columns.statusWrite) && readFollowsWrite) {
    const word = textOf(cellOf(row, config.columns.statusRead));
    snapshot.statusKey = normaliseKey(word);
    // With the word, the Knit status it maps to, as a pull would record it (10.3): the next
    // pull then sees Knit's own write as no change.
    snapshot.status = mapSourceStatus(word, config).status;
  }
  if (config.columns.completedOn && wrote(config.columns.completedOn)) {
    snapshot.completedOn = dateOf(
      cellOf(row, config.columns.completedOn),
      today,
    );
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

/**
 * The write that puts one cell back as `original` had it, or null when no write can do that
 * exactly (a checkbox, a date with a time, a number outside the completed-on column).
 */
function restoreOf(
  original: SheetRow,
  cell: CellWrite,
  config: TrackerConfig,
): CellWrite | null {
  const was = cellOf(original, cell.header);
  const at = { row: cell.row, header: cell.header };
  if (textOf(was) === "" && (was.value === null || was.value === "")) {
    return { ...at, kind: "text", value: "" };
  }
  if (typeof was.value === "string") {
    return { ...at, kind: "text", value: was.value };
  }
  if (
    typeof was.value === "number" &&
    Number.isInteger(was.value) &&
    sameHeader(cell.header, config.columns.completedOn)
  ) {
    return { ...at, kind: "date", value: fromSheetsSerial(was.value) };
  }
  return null;
}

async function pushTracker(
  deps: { store: SyncStore; source: SheetSource },
  items: ClaimedWrite[],
  today: LocalDate,
  stats: PushStats,
): Promise<void> {
  const { store, source } = deps;
  const first = items[0]!;
  const trackerId = first.tracker.id;
  const config = TrackerConfig.parse(first.tracker.config);
  const ref: TabRef = {
    fileId: first.tracker.fileId,
    sheetId: Number(first.tracker.sheetGid),
  };
  const settled = new Set<string>();
  const settle = async (
    item: ClaimedWrite,
    ok: boolean,
    snapshot: Partial<SourceSnapshot> | null,
    error: string | null,
    statusRaw: string | null = null,
  ) => {
    settled.add(item.outboxId);
    await store.pushResult(item.outboxId, ok, snapshot, error, statusRaw);
    // As push_result decides: a pasted copy (duplicate_knit_id) always retries (N22).
    if (ok) stats.done += 1;
    else if (
      error === "row_not_found" ||
      error === "formula_column" ||
      (error !== "duplicate_knit_id" && item.attempts + 1 >= 5)
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
    // Every row with a Knit ID, for putting a stray write back (a cleared row included).
    const beforeById = rowsByKnitId(before);
    // The task's row as the pull sees it (10.2 step 3): a Knit ID left on a row whose mapped
    // cells were all cleared is not a second row of the task.
    const holdersById = rowsByKnitId(rowsWithContent(before, config));
    // N59: a pull running beside this push (its own lease, 7.3) may have marked a claimed task
    // removed since push_claim, and its row may be back already. Asked after the read.
    const removedNow = new Set(
      (
        await store.removedTaskIds(
          items
            .filter((item) => !item.task.removedAtSource)
            .map((item) => item.task.id),
        )
      ).map((id) => id.toLowerCase()),
    );

    const planned: { item: ClaimedWrite; cells: CellWrite[] }[] = [];
    for (const item of items) {
      if (
        item.task.removedAtSource ||
        removedNow.has(item.task.id.toLowerCase())
      ) {
        // N11, N59: the removed task has no row. A row carrying its Knit ID again is a new task
        // (N30), so the removed task's values are never written to it.
        await settle(item, false, null, "row_not_found");
        continue;
      }
      const holders = holdersById.get(item.task.id.toLowerCase()) ?? [];
      if (holders.length === 0) {
        await settle(item, false, null, "row_not_found");
        continue;
      }
      if (holders.length > 1) {
        // 14: a pasted copy carries the Knit ID too. The next pull gives the lower row a new
        // ID (and raises duplicate_knit_id); until then Knit does not guess which row is the
        // task's, and the write-back waits for its retry.
        await settle(item, false, null, "duplicate_knit_id");
        continue;
      }
      const cells = cellsFor(item, config, holders[0]!.rowNumber, today);
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
    let after: SheetRow[];
    try {
      after = await source
        .readRows(ref, config.headerRow)
        .catch(() => source.readRows(ref, config.headerRow));
    } catch (error) {
      // The write went out but cannot be checked. If rows moved meanwhile it may sit on other
      // rows, so say which rows were written instead of staying silent (invariant 7). The
      // write-backs are retried as usual.
      await store.raiseAttention(
        trackerId,
        null,
        "write_misplaced",
        "write_misplaced:unverified",
        {
          reason: "unverified",
          rows: [...new Set(planned.map((p) => p.cells[0]!.row))].sort(
            (a, b) => a - b,
          ),
        },
      );
      throw error;
    }
    const afterById = rowsByKnitId(rowsWithContent(after, config));
    const afterByNumber = new Map(after.map((row) => [row.rowNumber, row]));

    const repairs: CellWrite[] = [];
    const stray = new Map<number, Set<string>>();
    for (const { item, cells } of planned) {
      const id = item.task.id.toLowerCase();
      const holders = afterById.get(id) ?? [];
      const row = holders.length === 1 ? holders[0] : undefined;
      if (row && cells.every((cell) => holds(row, cell, today))) {
        const snapshot = writtenSnapshot(
          row,
          cells,
          config,
          today,
          structure.formulaColumns,
        );
        const statusRaw =
          snapshot?.statusKey !== undefined
            ? textOf(cellOf(row, config.columns.statusRead))
            : null;
        await settle(item, true, snapshot, null, statusRaw);
        continue;
      }
      // Rows moved between reading and writing: undo the write on whichever row got it, from
      // the values read just before. Only a row named by a Knit ID that was on one row before
      // is put back (invariant 3), and only with a write that restores its value exactly.
      for (const cell of cells) {
        const landed = afterByNumber.get(cell.row);
        if (!landed || !holds(landed, cell, today)) continue;
        const landedId = knitIdOf(landed);
        if (landedId === id) continue;
        const originals = beforeById.get(landedId) ?? [];
        const original = originals.length === 1 ? originals[0] : undefined;
        if (original && holds(original, cell, today)) continue;
        const restore = original ? restoreOf(original, cell, config) : null;
        if (restore) repairs.push(restore);
        else
          stray.set(
            cell.row,
            (stray.get(cell.row) ?? new Set()).add(cell.header),
          );
      }
      await settle(item, false, null, "verify_mismatch");
    }
    if (repairs.length > 0) {
      await source.writeCells(ref, config.headerRow, repairs);
      logEvent("push.repaired", {
        job: "push",
        tracker: trackerId,
        cells: repairs.length,
      });
    }
    for (const [row, headers] of stray) {
      await store.raiseAttention(
        trackerId,
        null,
        "write_misplaced",
        `write_misplaced:row:${row}`,
        { reason: "stray_write", row, headers: [...headers] },
      );
      logEvent("push.stray_write", { job: "push", tracker: trackerId, row });
    }
  } catch (error) {
    const message = errorSummary(error);
    logEvent("push.tracker_failed", {
      job: "push",
      tracker: trackerId,
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
