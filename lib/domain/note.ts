import { formatDay, type LocalDate } from "@/lib/time";

import type { KnitStatus } from "./config";

/**
 * PRD 6.9, D7: the Knit Note, the visible column Knit keeps current in every tracker. This is
 * the only implementation of these rules; the push job calls it when it writes a row.
 *
 * | State                         | Note                                                  |
 * | Open, never spilled           | empty, or "In progress" / "Blocked: {reason}"         |
 * | Open, spilled                 | "Spilled {n}x · now due {date}" (+ status as above)   |
 * | Done on time                  | "Done on {date}"                                      |
 * | Done after spills             | "Done on {date} · after {n} spills"                   |
 * | Done early                    | "Done early on {date} · planned {due}"                |
 * | Cancelled                     | "Cancelled: {reason}"                                 |
 * | History only (before go-live) | "Before Knit go-live"                                 |
 */

export const KNIT_NOTE_MAX_LENGTH = 80;

export interface NoteTask {
  status: KnitStatus;
  statusReason: string | null;
  completedOn: LocalDate | null;
  dueDate: LocalDate | null;
  historyOnly: boolean;
}

export interface NoteTaskDay {
  day: LocalDate;
  status: KnitStatus;
  spillIndex: number;
  locked: boolean;
}

const ELLIPSIS = String.fromCharCode(0x2026);

/** Keeps the note within 80 characters by shortening the reason, which is the free text. */
function fit(prefix: string, reason: string, suffix = ""): string {
  const room = KNIT_NOTE_MAX_LENGTH - prefix.length - suffix.length;
  if (reason.length <= room) return `${prefix}${reason}${suffix}`;
  return `${prefix}${reason.slice(0, Math.max(0, room - 1)).trimEnd()}${ELLIPSIS}${suffix}`;
}

function openStatusText(
  task: NoteTask,
): { prefix: string; reason: string } | null {
  if (task.status === "in_progress")
    return { prefix: "In progress", reason: "" };
  if (task.status === "blocked") {
    return task.statusReason
      ? { prefix: "Blocked: ", reason: task.statusReason }
      : { prefix: "Blocked", reason: "" };
  }
  return null;
}

export function renderKnitNote(
  task: NoteTask,
  taskDays: readonly NoteTaskDay[],
  today: LocalDate,
): string {
  if (task.historyOnly) return "Before Knit go-live";

  if (task.status === "cancelled") {
    return task.statusReason
      ? fit("Cancelled: ", task.statusReason)
      : "Cancelled";
  }

  const spills = taskDays.reduce((max, d) => Math.max(max, d.spillIndex), 0);

  if (task.status === "done") {
    const doneOn = task.completedOn ?? today;
    if (task.dueDate && doneOn < task.dueDate) {
      return `Done early on ${formatDay(doneOn)} · planned ${formatDay(task.dueDate)}`;
    }
    // The spills before it was done: those of the task-day it was done on. A correction to
    // Done cancels every later task-day (6.10), and their spills never happened as misses.
    const doneDay = taskDays
      .filter((d) => d.status === "done")
      .reduce<NoteTaskDay | null>(
        (latest, d) => (latest === null || d.day > latest.day ? d : latest),
        null,
      );
    const spilled = doneDay
      ? doneDay.spillIndex
      : taskDays
          .filter((d) => d.status !== "cancelled")
          .reduce((max, d) => Math.max(max, d.spillIndex), 0);
    if (spilled > 0) {
      return `Done on ${formatDay(doneOn)} · after ${spilled} ${spilled === 1 ? "spill" : "spills"}`;
    }
    return `Done on ${formatDay(doneOn)}`;
  }

  const status = openStatusText(task);
  const openDay = taskDays
    .filter((d) => !d.locked)
    .reduce<NoteTaskDay | null>(
      (latest, d) => (latest === null || d.day > latest.day ? d : latest),
      null,
    );

  if (spills > 0 && openDay) {
    const head = `Spilled ${spills}x · now due ${formatDay(openDay.day)}`;
    if (!status) return head;
    return fit(`${head} · ${status.prefix}`, status.reason);
  }
  if (!status) return "";
  return fit(status.prefix, status.reason);
}
