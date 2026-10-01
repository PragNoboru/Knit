import { normaliseKey, type TrackerConfig } from "./config";
import type { PlanTask } from "./planPull";
import { cellOf, plannedRawOf, textOf, type SheetRow } from "./rows";
import { renderTemplate } from "./templates";

/**
 * PRD 14: the Knit ID column was deleted. The tracker is paused, and the column is recreated
 * only after the admin confirms a preview that matches rows to tasks by source ID, or else by
 * title and planned date. A value shared by several rows or tasks matches nothing: those rows
 * become new tasks on the next pull, and tasks left without a row count as removed at source
 * (6.6), which is why the admin sees both lists first.
 */

export interface RecreateMatch {
  row: number;
  taskId: string;
  /** The task's title in Knit. */
  title: string;
  /** The row's title when it was matched, to check the write against (invariant 3). */
  rowTitle: string;
  by: "source_id" | "title_and_date";
}

export interface RecreatePlan {
  matches: RecreateMatch[];
  /** Rows no task matched: new tasks on the next pull. */
  newRows: { row: number; title: string }[];
  /** Open tasks no row matched: removed at source on the next pull. */
  missingTasks: { taskId: string; title: string }[];
}

/** A row's title as the pull renders it (8.2 titleTemplate). */
export const rowTitle = (row: SheetRow, config: TrackerConfig) =>
  renderTemplate(config.titleTemplate, (header) =>
    textOf(row.cells[header] ?? { value: null, formatted: "" }),
  ) || textOf(cellOf(row, config.columns.title));

const titleDateKey = (title: string, planned: string) =>
  `${normaliseKey(title)}|${normaliseKey(planned)}`;

/** Keys that occur exactly once. */
function unique<T>(items: readonly T[], keyOf: (item: T) => string | null) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (key && counts.get(key) === 1) map.set(key, item);
  }
  return map;
}

export function planKnitIdRecreate(
  rows: readonly SheetRow[],
  tasks: readonly PlanTask[],
  config: TrackerConfig,
): RecreatePlan {
  const open = tasks.filter((task) => !task.removedAtSource);
  const refHeader = config.columns.sourceRef;
  const rowRef = (row: SheetRow) =>
    refHeader ? normaliseKey(textOf(cellOf(row, refHeader))) || null : null;
  const rowKey = (row: SheetRow) =>
    // N66: the same planned_raw text the pull stored, End date included.
    titleDateKey(rowTitle(row, config), plannedRawOf(row, config));

  const tasksByRef = unique(open, (task) =>
    task.sourceRef ? normaliseKey(task.sourceRef) : null,
  );
  const rowsByRef = unique(rows, rowRef);
  const tasksByKey = unique(open, (task) =>
    titleDateKey(task.title, task.plannedRaw ?? ""),
  );
  const rowsByKey = unique(rows, rowKey);

  const used = new Set<string>();
  const matches: RecreateMatch[] = [];
  const newRows: RecreatePlan["newRows"] = [];
  for (const row of rows) {
    const ref = rowRef(row);
    const byRef =
      ref && rowsByRef.get(ref) === row ? tasksByRef.get(ref) : undefined;
    const key = rowKey(row);
    const byKey = rowsByKey.get(key) === row ? tasksByKey.get(key) : undefined;
    const task =
      byRef && !used.has(byRef.id)
        ? { task: byRef, by: "source_id" as const }
        : byKey && !used.has(byKey.id)
          ? { task: byKey, by: "title_and_date" as const }
          : null;
    if (task) {
      used.add(task.task.id);
      matches.push({
        row: row.rowNumber,
        taskId: task.task.id,
        title: task.task.title,
        rowTitle: rowTitle(row, config),
        by: task.by,
      });
    } else {
      newRows.push({ row: row.rowNumber, title: rowTitle(row, config) });
    }
  }
  return {
    matches,
    newRows,
    missingTasks: open
      .filter((task) => !used.has(task.id))
      .map((task) => ({ taskId: task.id, title: task.title })),
  };
}
