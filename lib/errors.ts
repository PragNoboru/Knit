/**
 * Server actions return `{ ok: true, data } | { ok: false, error }` (CLAUDE.md conventions),
 * and the error is a sentence a person can act on. The database functions raise short codes
 * (set_task_status, admin_correct_task_day, report_issue); this maps them to plain language.
 */

export type ActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string };

export const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
export const fail = <T = never>(error: string): ActionResult<T> => ({
  ok: false,
  error,
});

const MESSAGES: Record<string, string> = {
  not_allowed: "You don't have access to this task.",
  status_not_selectable: "That status can't be chosen.",
  reason_required: "Add a short reason.",
  reason_too_long: "The reason is too long. Keep it to one line.",
  task_not_found: "This task no longer exists.",
  task_removed_at_source:
    "This row was removed from the sheet, so it can't be changed.",
  task_day_locked: "This day is closed and can't be changed.",
  day_not_closed:
    "Yesterday is still being closed. Try again in a few minutes.",
  no_open_task_day: "This task has no open day to change.",
  correction_would_orphan_task:
    "This correction would leave the task with no open day. To reopen a finished task, correct the day it ended.",
  task_day_not_found: "This day of the task no longer exists.",
  task_day_not_locked:
    "Only a closed day can be corrected. Change the status instead.",
  calendar_not_covered: "The calendar does not cover this date yet.",
};

export const GENERIC_ERROR = "Something went wrong. Try again.";
export const SIGNED_OUT_ERROR = "Your session has ended. Sign in again.";
/** The request itself failed (no connection, a timeout): the server never answered. */
export const NETWORK_ERROR =
  "Knit couldn't reach the server. Check your connection and try again.";

/** The message for an error raised by a database function; unknown errors stay generic. */
export function messageFor(error: { message?: string } | null | undefined) {
  const code = error?.message?.trim() ?? "";
  return MESSAGES[code] ?? GENERIC_ERROR;
}
