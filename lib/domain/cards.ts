import { z } from "zod";

import { formatDate, formatDay, isLocalDate, type LocalDate } from "@/lib/time";

import { KNIT_STATUSES, USER_STATUSES, type KnitStatus } from "./config";

/**
 * PRD 12.3, 12.5, 12.6: a task as the screens show it, as the screen functions in the
 * database return it (supabase/migrations/*_screens.sql, knit_task_card). Parsed with zod
 * because it crosses a boundary.
 */

export const LocalDateSchema = z
  .string()
  .refine(isLocalDate, "Expected a yyyy-mm-dd date");

/** PRD 12.2: one colour per tracker, always shown with the tracker's name. */
export const TRACKER_COLORS = [
  "indigo",
  "teal",
  "amber",
  "rose",
  "violet",
  "emerald",
  "sky",
  "orange",
] as const;
export type TrackerColor = (typeof TRACKER_COLORS)[number];

export const TaskDayInfo = z.object({
  id: z.number().int(),
  day: LocalDateSchema,
  status: z.enum(KNIT_STATUSES),
  spillIndex: z.number().int().min(0),
  reason: z.string().nullable(),
  locked: z.boolean(),
  carriedStatus: z.enum(USER_STATUSES).nullable(),
  statusChangedOn: LocalDateSchema.nullable(),
  origin: z.enum(["planned", "spillover", "backlog", "completion"]),
});
export type TaskDayInfo = z.infer<typeof TaskDayInfo>;

/** pending and held: not yet in the sheet ("Syncing"); failed: "Not saved to sheet". */
export const SyncState = z.enum(["pending", "held", "failed"]).nullable();
export type SyncState = z.infer<typeof SyncState>;

export const TaskCard = z.object({
  taskId: z.uuid(),
  title: z.string(),
  subtitle: z.string().nullable(),
  critical: z.boolean(),
  dueDate: LocalDateSchema.nullable(),
  plannedStart: LocalDateSchema.nullable(),
  plannedEnd: LocalDateSchema.nullable(),
  plannedRaw: z.string().nullable(),
  dateKind: z.enum(["single", "window", "open"]).nullable(),
  taskStatus: z.enum(USER_STATUSES),
  taskReason: z.string().nullable(),
  completedOn: LocalDateSchema.nullable(),
  sourceRef: z.string().nullable(),
  rowHint: z.number().int().nullable(),
  historyOnly: z.boolean(),
  removed: z.boolean(),
  tracker: z.object({
    id: z.uuid(),
    name: z.string(),
    color: z.enum(TRACKER_COLORS),
    fileId: z.string(),
    gid: z.number().int(),
  }),
  taskDay: TaskDayInfo.nullable(),
  sync: SyncState,
  spillCount: z.number().int().min(0),
  editable: z.boolean(),
});
export type TaskCard = z.infer<typeof TaskCard>;

/** The status a row shows: its task-day's when it has one, else the task's. */
export function rowStatus(card: TaskCard): KnitStatus {
  return card.taskDay?.status ?? card.taskStatus;
}

/** The reason a row shows next to Blocked or Cancelled. */
export function rowReason(card: TaskCard): string | null {
  return card.taskDay ? card.taskDay.reason : card.taskReason;
}

/**
 * Whether the status control is enabled. A row for a task-day follows that task-day: never
 * when locked (6.4), nor while it waits for its day's close (N10). Other rows follow what
 * set_task_status would accept for the task.
 */
export function canChange(card: TaskCard, today: LocalDate): boolean {
  if (card.removed || card.historyOnly) return false;
  if (card.taskDay) return !card.taskDay.locked && card.taskDay.day >= today;
  return card.editable;
}

/** PRD 12.3: the link to the task's row in its sheet. */
export function sheetRowUrl(card: TaskCard): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(card.tracker.fileId)}/edit#gid=${card.tracker.gid}`;
  return card.rowHint === null ? base : `${base}&range=A${card.rowHint}`;
}

/** PRD 12.3: "Due Fri 23 Oct · planned Sun 25 Oct"; open-ended tasks: "From Fri 30 Oct". */
export function dueLabel(card: TaskCard): string | null {
  if (card.dueDate === null) {
    return card.plannedStart === null
      ? null
      : `From ${formatDay(card.plannedStart)}`;
  }
  const due = `Due ${formatDay(card.dueDate)}`;
  const planned = card.plannedEnd ?? card.plannedStart;
  return planned !== null && planned !== card.dueDate
    ? `${due} · planned ${formatDay(planned)}`
    : due;
}

/** PRD 12.3: the red badge on a spillover, "Spilled 2x · from Wed 30 Sep". */
export function spillBadge(card: TaskCard): string | null {
  const spill = card.taskDay?.spillIndex ?? 0;
  if (spill === 0) return null;
  return card.dueDate === null
    ? `Spilled ${spill}x`
    : `Spilled ${spill}x · from ${formatDay(card.dueDate)}`;
}

/** PRD 6.5: a task-day finished before its own date shows "Done early, 24 Sep". */
export function doneEarlyLabel(card: TaskCard): string | null {
  const day = card.taskDay;
  if (!day || day.status !== "done" || day.statusChangedOn === null)
    return null;
  return day.statusChangedOn < day.day
    ? `Done early, ${formatDate(day.statusChangedOn, "d MMM")}`
    : null;
}

/** PRD 12.3: inside a group, critical first, then due date, tracker name, title. */
export function compareCards(a: TaskCard, b: TaskCard): number {
  if (a.critical !== b.critical) return a.critical ? -1 : 1;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return (
    a.tracker.name.localeCompare(b.tracker.name, "en") ||
    a.title.localeCompare(b.title, "en") ||
    a.taskId.localeCompare(b.taskId)
  );
}
