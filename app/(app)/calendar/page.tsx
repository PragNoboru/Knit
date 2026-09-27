import type { Metadata } from "next";

import { MonthCalendar } from "@/components/month-calendar";
import { loadMonth } from "@/lib/screens";
import {
  addMonths,
  isLocalDate,
  startOfMonth,
  todayIST,
  type LocalDate,
} from "@/lib/time";
import { firstParam, hrefWith } from "@/lib/url";

import { DayScreen } from "../_parts/day-screen";

export const metadata: Metadata = { title: "Calendar · Knit" };

// PRD 12.4: the month calendar with the selected day's table below
// (?month=yyyy-mm&day=yyyy-mm-dd).
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const today = todayIST();
  const monthParam = `${firstParam(params, "month") ?? ""}-01`;
  const month = isLocalDate(monthParam) ? monthParam : startOfMonth(today);
  const dayParam = firstParam(params, "day");
  const selected: LocalDate | null =
    dayParam && isLocalDate(dayParam) && startOfMonth(dayParam) === month
      ? dayParam
      : startOfMonth(today) === month
        ? today
        : null;
  const data = await loadMonth(month);
  const monthKey = (date: LocalDate) => date.slice(0, 7);

  return (
    <div className="flex flex-col gap-8">
      <MonthCalendar
        month={month}
        days={data.days}
        today={data.today}
        selected={selected}
        hrefForDay={(day) =>
          hrefWith("/calendar", {}, { month: monthKey(day), day })
        }
        previousHref={hrefWith(
          "/calendar",
          {},
          { month: monthKey(addMonths(month, -1)) },
        )}
        nextHref={hrefWith(
          "/calendar",
          {},
          { month: monthKey(addMonths(month, 1)) },
        )}
      />
      {selected ? (
        <DayScreen
          day={selected}
          path="/calendar"
          params={{ ...params, month: monthKey(month), day: selected }}
          navigation={false}
        />
      ) : null}
    </div>
  );
}
