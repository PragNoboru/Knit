import { formatDay, maxDate, type LocalDate } from "@/lib/time";

/**
 * PRD 6.11, N61: the day Bring to today puts a task on. While the tracker's go-live date is
 * still ahead it is the go-live date, so no task-day lands on a day before go-live; from the
 * go-live date on it is today. backlog_action applies the same rule in SQL; this copy only tells
 * the admin where the tasks will go.
 */
export function bringToTodayDay(
  goLiveDate: LocalDate,
  today: LocalDate,
): LocalDate {
  return maxDate(goLiveDate, today);
}

/** The backlog review's hint under its actions while go-live is ahead (N61), else null. */
export function bringToTodayHint(
  goLiveDate: LocalDate,
  today: LocalDate,
): string | null {
  if (goLiveDate <= today) return null;
  const day = formatDay(bringToTodayDay(goLiveDate, today));
  return `Go-live is ${day}, so Bring to today puts tasks on ${day}, not today.`;
}
