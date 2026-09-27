import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { PullForwardButton } from "@/components/pull-forward-button";
import { TaskRow, TaskRowHeader } from "@/components/task-row";
import { TrackerChip } from "@/components/tracker-chip";
import { buttonVariants } from "@/components/ui/button";
import { dueLabel, type TaskCard } from "@/lib/domain/cards";
import {
  noticeText,
  type DayNotice,
  type DayView,
} from "@/lib/domain/day-view";
import { formatDay, type LocalDate } from "@/lib/time";

/** PRD 12.3, 12.7: the groups of a day and its message, as lib/domain/day-view decided them. */
export function DayGroups({
  view,
  today,
  drawerHref,
}: {
  view: DayView;
  today: LocalDate;
  drawerHref: (taskId: string) => string;
}) {
  return (
    <div className="flex flex-col gap-6">
      {view.notice ? (
        <Notice notice={view.notice} today={today} drawerHref={drawerHref} />
      ) : null}
      {view.groups.map((group) => {
        const list = (
          <>
            <TaskRowHeader />
            <ul className="flex flex-col gap-2 sm:gap-0">
              {group.rows.map(({ card, early }) => (
                <TaskRow
                  key={`${card.taskId}-${card.taskDay?.id ?? "task"}`}
                  card={card}
                  today={today}
                  early={early}
                  drawerHref={drawerHref(card.taskId)}
                />
              ))}
            </ul>
          </>
        );
        const heading = (
          <>
            {group.title}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {group.rows.length}
            </span>
          </>
        );
        return group.collapsed ? (
          <details key={group.key} className="group/details">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md py-1 text-base font-semibold [&::-webkit-details-marker]:hidden">
              <ChevronRight
                aria-hidden
                className="size-4 transition-transform group-open/details:rotate-90"
              />
              {heading}
            </summary>
            <div className="mt-2">{list}</div>
          </details>
        ) : (
          <section key={group.key} aria-label={group.title}>
            <h2 className="mb-2 text-base font-semibold">{heading}</h2>
            {list}
          </section>
        );
      })}
    </div>
  );
}

function Notice({
  notice,
  today,
  drawerHref,
}: {
  notice: DayNotice;
  today: LocalDate;
  drawerHref: (taskId: string) => string;
}) {
  const text = (
    <p className="text-base font-medium" role="status">
      {noticeText(notice)}
    </p>
  );
  const box = "rounded-xl border bg-card p-4 sm:p-5";
  switch (notice.kind) {
    case "no_trackers":
      return (
        <div className={box}>
          {text}
          <Link
            href="/admin/trackers"
            className={`${buttonVariants({ size: "sm" })} mt-3`}
          >
            Open Trackers
          </Link>
        </div>
      );
    case "no_tasks":
      return (
        <div className={box}>
          {text}
          {notice.adminContact ? (
            <a
              href={`mailto:${notice.adminContact.email}`}
              className={`${buttonVariants({ size: "sm", variant: "outline" })} mt-3`}
            >
              Contact {notice.adminContact.name}
            </a>
          ) : null}
        </div>
      );
    case "off_day":
      return (
        <div className={box}>
          {text}
          {notice.nextWorkingDay ? (
            <Link
              href={
                notice.nextWorkingDay === today
                  ? "/"
                  : `/day/${notice.nextWorkingDay}`
              }
              className={`${buttonVariants({ size: "sm", variant: "outline" })} mt-3`}
            >
              Next working day, {formatDay(notice.nextWorkingDay)}
            </Link>
          ) : null}
        </div>
      );
    case "nothing_planned":
      return (
        <div className={box}>
          {text}
          {notice.upcoming.length > 0 ? (
            <ul className="mt-3 flex flex-col divide-y">
              {notice.upcoming.map((card) => (
                <UpcomingRow
                  key={card.taskId}
                  card={card}
                  drawerHref={drawerHref(card.taskId)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "all_clear":
      return (
        <div className={box}>
          {text}
          {notice.nextWorkingDay && notice.nextDayRows.length > 0 ? (
            <details className="group/next mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden
                  className="size-4 transition-transform group-open/next:rotate-90"
                />
                {formatDay(notice.nextWorkingDay)} · {notice.nextDayRows.length}{" "}
                {notice.nextDayRows.length === 1 ? "task" : "tasks"}
              </summary>
              <ul className="mt-2 flex flex-col gap-2 sm:gap-0">
                {notice.nextDayRows.map((card) => (
                  <TaskRow
                    key={card.taskId}
                    card={card}
                    today={today}
                    drawerHref={drawerHref(card.taskId)}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      );
    default:
      return <div className={box}>{text}</div>;
  }
}

function UpcomingRow({
  card,
  drawerHref,
}: {
  card: TaskCard;
  drawerHref: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <Link
          href={drawerHref}
          scroll={false}
          className="font-medium break-words underline-offset-2 hover:underline"
        >
          {card.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TrackerChip name={card.tracker.name} color={card.tracker.color} />
          <span>{dueLabel(card)}</span>
        </div>
      </div>
      <PullForwardButton taskId={card.taskId} title={card.title} />
    </li>
  );
}
