import { formatDay, maxDate, type LocalDate } from "@/lib/time";

import { CalendarNotCoveredError, type WorkingCalendar } from "./calendar";

/**
 * PRD 6.11, N61: the day Bring to today puts a task on: the first working day on or after the
 * later of today and the tracker's go-live date. While go-live is ahead that is the go-live
 * date, or the working day after it when go-live is an off day; from go-live on it is today,
 * or the next working day when today is an off day. Throws CalendarNotCoveredError when the
 * calendar does not reach that day (invariant 7). backlog_action applies the same rule in SQL;
 * this copy only tells the admin where the tasks will go.
 */
export function bringToTodayDay(
  goLiveDate: LocalDate,
  today: LocalDate,
  calendar: WorkingCalendar,
): LocalDate {
  const from = maxDate(goLiveDate, today);
  return calendar.isWorkingDay(from) ? from : calendar.nextWorkingDay(from);
}

/**
 * The backlog review's hint under its actions (N61): where Bring to today puts tasks when that
 * is not today, else null. When the calendar does not reach that day, Bring to today is
 * refused (calendar_not_covered), and the hint says so.
 */
export function bringToTodayHint(
  goLiveDate: LocalDate,
  today: LocalDate,
  calendar: WorkingCalendar,
): string | null {
  const from = maxDate(goLiveDate, today);
  let day: LocalDate;
  try {
    day = bringToTodayDay(goLiveDate, today, calendar);
  } catch (error) {
    if (error instanceof CalendarNotCoveredError)
      return `The calendar does not cover ${formatDay(error.day)} yet, so Bring to today cannot place tasks.`;
    throw error;
  }
  if (day === today) return null;
  const target = formatDay(day);
  if (goLiveDate > today) {
    const goLive = formatDay(goLiveDate);
    if (day === goLiveDate)
      return `Go-live is ${goLive}, so Bring to today puts tasks on ${target}, not today.`;
    return `Go-live is ${goLive}, a day off (${calendar.offReason(from)}), so Bring to today puts tasks on ${target}, the next working day.`;
  }
  return `Today is a day off (${calendar.offReason(today)}), so Bring to today puts tasks on ${target}, the next working day.`;
}
