import { z } from "zod";

import {
  addDays,
  daysInMonth,
  isoWeekday,
  monthOf,
  startOfMonth,
  yearOf,
  type LocalDate,
} from "@/lib/time";

import { LocalDateSchema } from "./cards";

/**
 * PRD 12.4: the month calendar. month_view returns, for every day of the month, the counts of
 * the caller's task-days; this module turns them into the grid and each day's colour.
 */

export const MonthDay = z.object({
  day: LocalDateSchema,
  isWorking: z.boolean(),
  reason: z.string().nullable(),
  total: z.number().int().min(0),
  finished: z.number().int().min(0),
  notDone: z.number().int().min(0),
  open: z.number().int().min(0),
  locked: z.boolean(),
});
export type MonthDay = z.infer<typeof MonthDay>;

export const MonthData = z.object({
  today: LocalDateSchema,
  days: z.array(MonthDay),
});
export type MonthData = z.infer<typeof MonthData>;

export type DayColour = "green" | "red" | "amber" | "blank";

/**
 * PRD 12.4 with N18: red when a locked day has a Not Done; amber while work is open (today,
 * later days, and an earlier day not closed yet or holding a Blocked); green when every
 * task-day is done or cancelled; blank when there is nothing. Off days are also hatched,
 * with their reason on hover (see `isOff`).
 */
export function dayColour(day: MonthDay): DayColour {
  if (day.total === 0) return "blank";
  if (day.notDone > 0) return "red";
  if (day.open > 0) return "amber";
  return "green";
}

export const isOff = (day: MonthDay) => !day.isWorking;

/** Monday-first weeks for the month holding `month`; null pads the first and last week. */
export function monthGrid(month: LocalDate): (LocalDate | null)[][] {
  const first = startOfMonth(month);
  const count = daysInMonth(yearOf(first), monthOf(first));
  const cells: (LocalDate | null)[] = [
    ...Array.from({ length: isoWeekday(first) - 1 }, () => null),
    ...Array.from({ length: count }, (_, i) => addDays(first, i)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (LocalDate | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
