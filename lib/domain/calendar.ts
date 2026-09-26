import { addDays, dayOfMonth, isoWeekday, type LocalDate } from "@/lib/time";

/**
 * PRD 6.2: the working-day calendar. At run time the jobs build it from the database's
 * calendar_days (which reflects holiday edits); calendarDaysFromRules computes the same rows
 * from the rules, mirroring refresh_calendar in SQL, for tests and fixtures.
 */

export interface CalendarDay {
  day: LocalDate;
  isWorking: boolean;
  /** Why an off day is off ("Sunday", "2nd Saturday", "Dussehra"); null on working days. */
  reason: string | null;
}

export interface Holiday {
  date: LocalDate;
  name: string;
}

export class CalendarNotCoveredError extends Error {
  override name = "CalendarNotCoveredError";
  constructor(readonly day: LocalDate) {
    super(`The working-day calendar does not cover ${day}.`);
  }
}

export interface WorkingCalendar {
  readonly first: LocalDate;
  readonly last: LocalDate;
  covers(day: LocalDate): boolean;
  isWorkingDay(day: LocalDate): boolean;
  /** Why the day is off, or null for a working day. */
  offReason(day: LocalDate): string | null;
  nextWorkingDay(day: LocalDate): LocalDate;
  prevWorkingDay(day: LocalDate): LocalDate;
}

const SATURDAY_ORDINALS: Record<number, string> = {
  2: "2nd",
  4: "4th",
  5: "5th",
};

/** The reason a day is off under PRD 6.2 (and N2), or null for a working day. */
export function offDayReason(
  day: LocalDate,
  holidayName: string | undefined,
): string | null {
  if (holidayName) return holidayName;
  const weekday = isoWeekday(day);
  if (weekday === 7) return "Sunday";
  if (weekday === 6) {
    const position = Math.ceil(dayOfMonth(day) / 7);
    if (position !== 1 && position !== 3)
      return `${SATURDAY_ORDINALS[position]} Saturday`;
  }
  return null;
}

/** Calendar rows for [from, to] computed from the rules; same result as refresh_calendar. */
export function calendarDaysFromRules(
  holidays: readonly Holiday[],
  from: LocalDate,
  to: LocalDate,
): CalendarDay[] {
  const names = new Map(holidays.map((h) => [h.date, h.name]));
  const days: CalendarDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const reason = offDayReason(day, names.get(day));
    days.push({ day, isWorking: reason === null, reason });
  }
  return days;
}

/** A calendar over contiguous days. Lookups outside it throw instead of guessing (invariant 7). */
export function calendarFromDays(
  days: readonly CalendarDay[],
): WorkingCalendar {
  if (days.length === 0) throw new Error("A calendar needs at least one day.");
  const sorted = [...days].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const byDay = new Map(sorted.map((d) => [d.day, d]));
  const first = sorted[0]!.day;
  const last = sorted[sorted.length - 1]!.day;

  const lookup = (day: LocalDate): CalendarDay => {
    const entry = byDay.get(day);
    if (!entry) throw new CalendarNotCoveredError(day);
    return entry;
  };

  const step = (day: LocalDate, direction: 1 | -1): LocalDate => {
    lookup(day);
    for (let d = addDays(day, direction); ; d = addDays(d, direction)) {
      if (lookup(d).isWorking) return d;
    }
  };

  return {
    first,
    last,
    covers: (day) => byDay.has(day),
    isWorkingDay: (day) => lookup(day).isWorking,
    offReason: (day) => lookup(day).reason,
    nextWorkingDay: (day) => step(day, 1),
    prevWorkingDay: (day) => step(day, -1),
  };
}
