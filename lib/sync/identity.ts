import { randomUUID } from "node:crypto";

import { normaliseKey, type TrackerConfig } from "@/lib/domain/config";
import { cellOf, textOf, type SheetRow } from "@/lib/domain/rows";
import {
  KNIT_ID_HEADER,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";

/**
 * PRD 10.2 step 4, N7, invariant 3: rows are identified only by the Knit ID in the sheet.
 *   * Rows with a Knit ID are matched to tasks.
 *   * The same Knit ID on two rows (or one that belongs to another tracker): the lower row is
 *     treated as new and gets a new ID; attention duplicate_knit_id.
 *   * Rows without one get a new UUID written into the sheet first. The Knit ID and title
 *     columns are then read back, and each new ID must sit beside the title it was made for.
 *     If not (someone inserted or sorted rows meanwhile), those IDs are cleared and the rows
 *     wait for the next pull. Only confirmed rows go on.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdentityAttention {
  kind: "duplicate_knit_id";
  dedupeKey: string;
  detail: Record<string, unknown>;
}

export interface IdentityResult {
  /** Rows whose Knit ID is confirmed, re-read after any writes. */
  rows: SheetRow[];
  attention: IdentityAttention[];
  written: number;
  cleared: number;
}

const idOf = (row: SheetRow) =>
  textOf(cellOf(row, KNIT_ID_HEADER)).toLowerCase();
const titleOf = (row: SheetRow, config: TrackerConfig) =>
  textOf(cellOf(row, config.columns.title));

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
    (
      await idsElsewhere([
        ...new Set(rows.map(idOf).filter((id) => UUID.test(id))),
      ])
    ).map((id) => id.toLowerCase()),
  );

  const seen = new Set<string>();
  const needsId: SheetRow[] = [];
  for (const row of rows) {
    const id = idOf(row);
    if (!UUID.test(id)) {
      needsId.push(row);
    } else if (seen.has(id) || elsewhere.has(id)) {
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
      seen.add(id);
    }
  }
  if (needsId.length === 0) return { rows, attention, written: 0, cleared: 0 };

  const assigned = new Map<string, { row: number; title: string }>();
  for (const row of needsId)
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
  const confirmed = new Set<string>();
  const toClear: number[] = [];
  for (const [id, expected] of assigned) {
    const holder = after.find((row) => idOf(row) === id);
    if (
      holder &&
      holder.rowNumber === expected.row &&
      normaliseKey(titleOf(holder, config)) === normaliseKey(expected.title)
    ) {
      confirmed.add(id);
    } else if (holder) {
      toClear.push(holder.rowNumber);
    }
  }
  if (toClear.length > 0) {
    await source.writeCells(
      ref,
      config.headerRow,
      toClear.map((row) => ({
        row,
        header: KNIT_ID_HEADER,
        kind: "text",
        value: "",
      })),
    );
  }

  const keep = new Set([...seen, ...confirmed]);
  const cleared = new Set(toClear);
  const confirmedRows = after.filter(
    (row) => !cleared.has(row.rowNumber) && keep.has(idOf(row)),
  );
  return {
    rows: confirmedRows,
    attention,
    written: assigned.size,
    cleared: toClear.length,
  };
}
