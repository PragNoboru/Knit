import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDot,
  CircleX,
} from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import {
  dayColour,
  isOff,
  monthGrid,
  type DayColour,
  type MonthDay,
} from "@/lib/domain/month-view";
import {
  dayOfMonth,
  formatDate,
  formatDay,
  WEEKDAYS,
  type LocalDate,
} from "@/lib/time";
import { cn } from "@/lib/utils";

const COLOUR: Record<DayColour, string> = {
  green:
    "bg-emerald-100 text-emerald-950 dark:bg-emerald-400/15 dark:text-emerald-100",
  red: "bg-red-100 text-red-950 dark:bg-red-400/15 dark:text-red-100",
  amber: "bg-amber-100 text-amber-950 dark:bg-amber-400/15 dark:text-amber-100",
  blank: "",
};

const ICON = { green: CircleCheck, red: CircleX, amber: CircleDot } as const;

const SAYS: Record<DayColour, string> = {
  green: "all done",
  red: "missed tasks",
  amber: "open tasks",
  blank: "",
};

/**
 * PRD 12.4: the month grid, Monday first. Each day shows its colour, an icon and a count, so
 * the state never relies on colour alone (12.2); off days are hatched with the reason on hover.
 */
export function MonthCalendar({
  month,
  days,
  today,
  selected,
  hrefForDay,
  previousHref,
  nextHref,
}: {
  month: LocalDate;
  days: MonthDay[];
  today: LocalDate;
  selected: LocalDate | null;
  hrefForDay: (day: LocalDate) => string;
  previousHref: string;
  nextHref: string;
}) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  return (
    <section aria-label="Calendar" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {formatDate(month, "MMMM yyyy")}
        </h1>
        <div className="flex items-center gap-1">
          <Link
            href={previousHref}
            aria-label="Previous month"
            className={buttonVariants({ variant: "outline", size: "icon" })}
          >
            <ChevronLeft aria-hidden />
          </Link>
          <Link
            href="/calendar"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            This month
          </Link>
          <Link
            href={nextHref}
            aria-label="Next month"
            className={buttonVariants({ variant: "outline", size: "icon" })}
          >
            <ChevronRight aria-hidden />
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {monthGrid(month)
          .flat()
          .map((day, index) => {
            if (day === null) return <span key={`pad-${index}`} />;
            const info = byDay.get(day);
            const colour = info ? dayColour(info) : "blank";
            const off = info ? isOff(info) : false;
            const Icon = colour === "blank" ? null : ICON[colour];
            const label = [
              formatDay(day),
              off ? `day off, ${info?.reason ?? ""}` : null,
              info && info.total > 0
                ? `${info.total} ${info.total === 1 ? "task" : "tasks"}, ${SAYS[colour]}`
                : null,
            ]
              .filter(Boolean)
              .join(", ");
            return (
              <Link
                key={day}
                href={hrefForDay(day)}
                scroll={false}
                aria-label={label}
                aria-current={day === selected ? "date" : undefined}
                title={off ? (info?.reason ?? undefined) : undefined}
                className={cn(
                  "flex aspect-square min-h-11 flex-col justify-between rounded-lg border p-1 text-left transition-colors hover:border-foreground/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none sm:aspect-auto sm:h-20 sm:p-2",
                  COLOUR[colour],
                  off && "bg-hatched text-muted-foreground",
                  day === selected && "ring-2 ring-foreground",
                )}
              >
                <span
                  className={cn(
                    "text-xs sm:text-sm",
                    day === today &&
                      "inline-flex size-6 items-center justify-center rounded-full bg-foreground font-semibold text-background",
                  )}
                >
                  {dayOfMonth(day)}
                </span>
                {info && info.total > 0 ? (
                  <span className="flex items-center gap-1 self-end text-[0.7rem] tabular-nums sm:text-xs">
                    {Icon ? <Icon aria-hidden className="size-3" /> : null}
                    {info.total}
                  </span>
                ) : null}
              </Link>
            );
          })}
      </div>
    </section>
  );
}
