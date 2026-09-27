import { randomUUID } from "node:crypto";

import { normaliseKey, type TrackerConfig } from "@/lib/domain/config";
import { cellOf, textOf, type SheetRow } from "@/lib/domain/rows";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type CellWrite,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";

/**
 * PRD 10.2 step 4, N7, invariant 3: rows are identified only by the Knit ID in the sheet.
 *   * Rows with a Knit ID are matched to tasks. The ID is compared lower-cased, so an ID typed
 *     again in capitals is still the same ID.
 *   * The same Knit ID on two rows (or one that belongs to another tracker): the lower row is
 *     treated as new and gets a new ID; attention duplicate_knit_id.
 *   * Rows without one get a new UUID written into the sheet first. Just before writing, the
 *     rows are read again and an ID is written only where the same row still has the same
 *     title and Knit ID as when it was read. The rows are then read back, and each new ID must
 *     sit beside the title it was made for. If not (someone inserted, deleted or sorted rows
 *     meanwhile), the ID is taken out again and the row waits for the next pull. When the new
 *     ID landed on a row that had a Knit ID of its own, that ID is put back (found by the row's
 *     content, else its title, in the read made just before writing), never left blank.
 *   * If a Knit ID Knit overwrote cannot be put back, the rows are not a safe picture of the
 *     sheet: the result is `unstable`, the pull applies nothing this time (its task would count
 *     as removed) and attention write_misplaced names the row.
 *   Only confirmed rows go on, one row per Knit ID (the upper one).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IdentityAttention {
  kind: "duplicate_knit_id" | "write_misplaced";
  dedupeKey: string;
  detail: Record<string, unknown>;
}

export interface IdentityResult {
  /** Rows whose Knit ID is confirmed, re-read after any writes; the ID cell lower-cased. */
  rows: SheetRow[];
  attention: IdentityAttention[];
  written: number;
  cleared: number;
  /** Knit IDs put back on rows a new ID had landed on by mistake. */
  restored: number;
  /** A Knit ID was overwritten and could not be put back: apply no plan from these rows. */
  unstable: boolean;
}

const KNIT_ID_KEY = normaliseKey(KNIT_ID_HEADER);
const KNIT_NOTE_KEY = normaliseKey(KNIT_NOTE_HEADER);

/** The row's Knit ID, trimmed and lower-cased ("" when it has none). */
export const knitIdOf = (row: SheetRow): string =>
  textOf(cellOf(row, KNIT_ID_HEADER)).toLowerCase();

const validId = (id: string) => UUID.test(id);

/**
 * Rows by Knit ID (lower-cased), in sheet order. An ID found on more than one row maps to all
 * of them, so a caller can refuse to guess which row is the task's. Rows without a valid Knit
 * ID are left out.
 */
export function rowsByKnitId(
  rows: readonly SheetRow[],
): Map<string, SheetRow[]> {
  const byId = new Map<string, SheetRow[]>();
  for (const row of rows) {
    const id = knitIdOf(row);
    if (!validId(id)) continue;
    byId.set(id, [...(byId.get(id) ?? []), row]);
  }
  return byId;
}

const titleOf = (row: SheetRow, config: TrackerConfig) =>
  normaliseKey(textOf(cellOf(row, config.columns.title)));

/** Everything in the row except its Knit ID and Knit Note, for finding the same row again. */
function contentOf(row: SheetRow): string {
  return JSON.stringify(
    Object.keys(row.cells)
      .filter((key) => key !== KNIT_ID_KEY && key !== KNIT_NOTE_KEY)
      .sort()
      .map((key) => [key, row.cells[key]!.value, row.cells[key]!.formatted]),
  );
}

/** The row with `id` in its Knit ID cell. */
function withKnitId(row: SheetRow, id: string): SheetRow {
  const cell = row.cells[KNIT_ID_KEY];
  if (cell && cell.value === id && cell.formatted === id) return row;
  return {
    ...row,
    cells: { ...row.cells, [KNIT_ID_KEY]: { value: id, formatted: id } },
  };
}

/** The first row of each kept ID, in sheet order, its Knit ID lower-cased. */
function firstRowPerId(rows: readonly SheetRow[], keep: ReadonlySet<string>) {
  const taken = new Set<string>();
  const result: SheetRow[] = [];
  for (const row of rows) {
    const id = knitIdOf(row);
    if (!keep.has(id) || taken.has(id)) continue;
    taken.add(id);
    result.push(withKnitId(row, id));
  }
  return result;
}

function countIds(rows: readonly SheetRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id, holders] of rowsByKnitId(rows))
    counts.set(id, holders.length);
  return counts;
}

/**
 * The Knit ID a row had before a new ID landed on it: among the IDs that went missing, the one
 * whose row (in the read made just before writing) has the same content, else the same title.
 * Null when there is none, or more than one (never guess, invariant 7).
 */
function originalIdOf(
  holder: SheetRow,
  beforeWrite: readonly SheetRow[],
  lost: ReadonlyMap<string, number>,
  config: TrackerConfig,
): string | null {
  const candidates = beforeWrite.filter(
    (row) => (lost.get(knitIdOf(row)) ?? 0) > 0,
  );
  const only = (rows: SheetRow[]) => {
    const ids = [...new Set(rows.map(knitIdOf))];
    return ids.length === 1 ? ids[0]! : ids.length === 0 ? undefined : null;
  };
  const byContent = only(
    candidates.filter((row) => contentOf(row) === contentOf(holder)),
  );
  if (byContent !== undefined) return byContent;
  const byTitle = only(
    candidates.filter(
      (row) => titleOf(row, config) === titleOf(holder, config),
    ),
  );
  return byTitle ?? null;
}

export async function ensureKnitIds(
  source: SheetSource,
  ref: TabRef,
  config: TrackerConfig,
  rows: SheetRow[],
  idsElsewhere: (ids: string[]) => Promise<string[]>,
  reread: () => Promise<SheetRow[]>,
): Promise<IdentityResult> {
  const attention: IdentityAttention[] = [];
  const elsewhere = new Set(
    (await idsElsewhere([...new Set(rows.map(knitIdOf).filter(validId))])).map(
      (id) => id.toLowerCase(),
    ),
  );

  const owned = new Set<string>();
  const needsId: SheetRow[] = [];
  for (const row of rows) {
    const id = knitIdOf(row);
    if (!validId(id)) {
      needsId.push(row);
    } else if (owned.has(id) || elsewhere.has(id)) {
      attention.push({
        kind: "duplicate_knit_id",
        dedupeKey: `duplicate_knit_id:${id}`,
        detail: {
          knitId: id,
          row: row.rowNumber,
          otherTracker: elsewhere.has(id),
        },
      });
      needsId.push(row);
    } else {
      owned.add(id);
    }
  }
  const unchanged = (current: SheetRow[]): IdentityResult => ({
    rows: firstRowPerId(current, owned),
    attention,
    written: 0,
    cleared: 0,
    restored: 0,
    unstable: false,
  });
  if (needsId.length === 0) return unchanged(rows);

  // Invariant 3: the rows may have moved since they were read. Write only where the same row
  // number still holds the same title and Knit ID; the others wait for the next pull.
  const beforeWrite = await reread();
  const beforeByNumber = new Map(beforeWrite.map((r) => [r.rowNumber, r]));
  const targets = needsId.filter((row) => {
    const now = beforeByNumber.get(row.rowNumber);
    return (
      now !== undefined &&
      knitIdOf(now) === knitIdOf(row) &&
      titleOf(now, config) === titleOf(row, config)
    );
  });
  if (targets.length === 0) return unchanged(rows);

  const assigned = new Map<string, { row: number; title: string }>();
  for (const row of targets)
    assigned.set(randomUUID(), {
      row: row.rowNumber,
      title: titleOf(row, config),
    });
  await source.writeCells(
    ref,
    config.headerRow,
    [...assigned].map(([id, { row }]) => ({
      row,
      header: KNIT_ID_HEADER,
      kind: "text",
      value: id,
    })),
  );

  const after = await reread();

  // Knit IDs that were in the sheet just before the write and are gone now: overwritten by a
  // new ID that landed on the wrong row (or, rarely, deleted by someone meanwhile). A duplicate
  // Knit ID that a new ID was meant to replace is not lost.
  const replaced = new Map<string, number>();
  for (const row of targets) {
    const id = knitIdOf(row);
    if (validId(id)) replaced.set(id, (replaced.get(id) ?? 0) + 1);
  }
  const lost = new Map<string, number>();
  const afterCounts = countIds(after);
  for (const [id, count] of countIds(beforeWrite)) {
    const missing =
      count - (afterCounts.get(id) ?? 0) - (replaced.get(id) ?? 0);
    if (missing > 0) lost.set(id, missing);
  }
  const lostContent = new Set(
    beforeWrite
      .filter((row) => lost.has(knitIdOf(row)))
      .map((row) => contentOf(row)),
  );

  const confirmed = new Set<string>();
  const misplaced: SheetRow[] = [];
  for (const [id, expected] of assigned) {
    const holders = after.filter((row) => knitIdOf(row) === id);
    const [holder] = holders;
    if (
      holders.length === 1 &&
      holder!.rowNumber === expected.row &&
      titleOf(holder!, config) === expected.title &&
      // Same title, but it is the row whose Knit ID went missing (two rows with one title).
      !lostContent.has(contentOf(holder!))
    ) {
      confirmed.add(id);
    } else {
      misplaced.push(...holders);
    }
  }

  const repairs: CellWrite[] = [];
  const restoredAt = new Map<number, string>();
  const clearedAt = new Set<number>();
  for (const holder of misplaced) {
    const original =
      lost.size > 0 ? originalIdOf(holder, beforeWrite, lost, config) : null;
    if (original) {
      restoredAt.set(holder.rowNumber, original);
      lost.set(original, lost.get(original)! - 1);
    } else {
      clearedAt.add(holder.rowNumber);
    }
    repairs.push({
      row: holder.rowNumber,
      header: KNIT_ID_HEADER,
      kind: "text",
      value: original ?? "",
    });
  }
  if (repairs.length > 0) {
    await source.writeCells(ref, config.headerRow, repairs);
  }

  const stillLost = [...lost].filter(([, n]) => n > 0).map(([id]) => id);
  const unstable = misplaced.length > 0 && stillLost.length > 0;
  if (unstable) {
    for (const id of stillLost) {
      attention.push({
        kind: "write_misplaced",
        dedupeKey: `write_misplaced:knit_id:${id}`,
        detail: {
          reason: "knit_id_lost",
          knitId: id,
          row: beforeWrite.find((row) => knitIdOf(row) === id)?.rowNumber,
        },
      });
    }
  }

  const current = after
    .filter((row) => !clearedAt.has(row.rowNumber))
    .map((row) => {
      const id = restoredAt.get(row.rowNumber);
      return id ? withKnitId(row, id) : row;
    });
  return {
    rows: firstRowPerId(current, new Set([...owned, ...confirmed])),
    attention,
    written: assigned.size,
    cleared: clearedAt.size,
    restored: restoredAt.size,
    unstable,
  };
}
