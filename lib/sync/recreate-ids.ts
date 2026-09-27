import { normaliseKey } from "@/lib/domain/config";
import {
  planKnitIdRecreate,
  rowTitle,
  type RecreatePlan,
} from "@/lib/domain/knit-id-recreate";
import { cellOf, isEmptyRow, textOf } from "@/lib/domain/rows";
import {
  KNIT_ID_HEADER,
  type SheetSource,
  type TabRef,
} from "@/lib/sheets/types";

import type { SyncStore, SyncTracker } from "./store";

/**
 * PRD 14: recreating a deleted Knit ID column, after the admin saw the preview. The IDs are
 * written, read back and kept only where they sit beside the row they were matched to
 * (invariant 3); the others are cleared and those rows get new IDs on the next pull. Then the
 * tracker resumes.
 */

export async function previewKnitIdRecreate(
  deps: { store: SyncStore; source: SheetSource },
  tracker: SyncTracker,
): Promise<RecreatePlan> {
  const ref: TabRef = { fileId: tracker.fileId, sheetId: tracker.sheetGid };
  const rows = (
    await deps.source.readRows(ref, tracker.config.headerRow)
  ).filter((row) => !isEmptyRow(row, tracker.config));
  const { tasks } = await deps.store.loadPullState(tracker.id);
  return planKnitIdRecreate(rows, tasks, tracker.config);
}

export async function recreateKnitIds(
  deps: { store: SyncStore; source: SheetSource },
  tracker: SyncTracker,
): Promise<{ written: number; cleared: number }> {
  const { config } = tracker;
  const ref: TabRef = { fileId: tracker.fileId, sheetId: tracker.sheetGid };
  await deps.source.ensureKnitColumns(ref, config.headerRow);
  const plan = await previewKnitIdRecreate(deps, tracker);
  if (plan.matches.length > 0) {
    await deps.source.writeCells(
      ref,
      config.headerRow,
      plan.matches.map((match) => ({
        row: match.row,
        header: KNIT_ID_HEADER,
        kind: "text",
        value: match.taskId,
      })),
    );
  }
  const expected = new Map(plan.matches.map((m) => [m.taskId, m]));
  const after = await deps.source.readRows(ref, config.headerRow);
  const toClear: number[] = [];
  for (const row of after) {
    const id = textOf(cellOf(row, KNIT_ID_HEADER)).toLowerCase();
    const match = expected.get(id);
    if (!match) continue;
    if (
      row.rowNumber !== match.row ||
      normaliseKey(rowTitle(row, config)) !== normaliseKey(match.rowTitle)
    )
      toClear.push(row.rowNumber);
  }
  if (toClear.length > 0) {
    await deps.source.writeCells(
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
  return {
    written: plan.matches.length - toClear.length,
    cleared: toClear.length,
  };
}
