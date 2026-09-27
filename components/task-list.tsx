import { Flame } from "lucide-react";
import Link from "next/link";

import { StatusControl } from "@/components/status-control";
import { TrackerChip } from "@/components/tracker-chip";
import { canChange, type TaskCard } from "@/lib/domain/cards";
import { formatDay, type LocalDate } from "@/lib/time";

const GRID =
  "md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)_6.5rem_11rem_3.5rem_6.5rem] md:items-center md:gap-x-3";

function plannedText(card: TaskCard): string {
  if (card.plannedStart === null) return card.plannedRaw ?? "";
  if (card.dateKind === "open") return `From ${formatDay(card.plannedStart)}`;
  if (card.plannedEnd !== null && card.plannedEnd !== card.plannedStart)
    return `${formatDay(card.plannedStart)} to ${formatDay(card.plannedEnd)}`;
  return formatDay(card.plannedStart);
}

/**
 * PRD 12.5: one task per row. Columns: Title, Tracker, Planned, Due, Status, Spill count,
 * Completed on. Rows become cards on narrow screens (12.2).
 */
export function TaskList({
  rows,
  today,
  drawerHref,
}: {
  rows: TaskCard[];
  today: LocalDate;
  drawerHref: (taskId: string) => string;
}) {
  return (
    <div>
      <div
        aria-hidden
        className={`hidden border-b px-1 pb-1.5 text-xs font-medium text-muted-foreground md:grid ${GRID}`}
      >
        <span>Title</span>
        <span>Tracker</span>
        <span>Planned</span>
        <span>Due</span>
        <span>Status</span>
        <span>Spills</span>
        <span>Completed on</span>
      </div>
      <ul className="flex flex-col gap-2 md:gap-0">
        {rows.map((card) => (
          <li
            key={card.taskId}
            className={`flex flex-col gap-2 rounded-lg border bg-card p-3 md:rounded-none md:border-0 md:border-b md:bg-transparent md:px-1 md:py-2.5 ${GRID}`}
          >
            <div className="min-w-0">
              <div className="flex items-start gap-1.5">
                {card.critical ? (
                  <Flame
                    aria-label="Critical"
                    className="mt-0.5 size-4 shrink-0 text-red-600"
                  />
                ) : null}
                <Link
                  href={drawerHref(card.taskId)}
                  scroll={false}
                  className="font-medium break-words underline-offset-2 hover:underline"
                >
                  {card.title}
                </Link>
              </div>
              {card.subtitle ? (
                <p className="text-xs break-words text-muted-foreground">
                  {card.subtitle}
                </p>
              ) : null}
            </div>
            <div className="min-w-0">
              <TrackerChip
                name={card.tracker.name}
                color={card.tracker.color}
              />
            </div>
            <Cell label="Planned">{plannedText(card)}</Cell>
            <Cell label="Due">
              {card.dueDate ? formatDay(card.dueDate) : ""}
            </Cell>
            <StatusControl
              taskId={card.taskId}
              title={card.title}
              status={card.taskStatus}
              enabled={canChange(card, today)}
              sync={card.sync}
              pull={card.dueDate !== null && card.dueDate > today}
            />
            <Cell label="Spills">{String(card.spillCount)}</Cell>
            <Cell label="Completed on">
              {card.completedOn ? formatDay(card.completedOn) : ""}
            </Cell>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex gap-2 text-xs text-muted-foreground md:block">
      <span className="w-24 shrink-0 md:sr-only">{label}</span>
      <span className="tabular-nums">{children}</span>
    </div>
  );
}
