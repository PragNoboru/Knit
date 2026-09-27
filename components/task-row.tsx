import { ExternalLink, Flame } from "lucide-react";
import Link from "next/link";

import { StatusControl } from "@/components/status-control";
import { TrackerChip } from "@/components/tracker-chip";
import {
  canChange,
  doneEarlyLabel,
  dueLabel,
  rowReason,
  rowStatus,
  sheetRowUrl,
  spillBadge,
  type TaskCard,
} from "@/lib/domain/cards";
import type { LocalDate } from "@/lib/time";

/**
 * PRD 12.3 row: critical marker, title and subtitle, tracker chip, due date (and planned date),
 * status control, spill count, Open in sheet. Under 640 px it is a stacked card with the status
 * control full width (12.2); the tracker and due date get their own columns from 1024 px.
 */

export const ROW_GRID =
  "sm:grid sm:grid-cols-[1.25rem_minmax(0,1fr)_11rem_3rem_2rem] sm:items-center sm:gap-x-3 lg:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,10rem)_minmax(0,14rem)_11rem_3rem_2rem]";

export function TaskRowHeader() {
  return (
    <div
      aria-hidden
      className={`hidden border-b px-1 pb-1.5 text-xs font-medium text-muted-foreground lg:grid ${ROW_GRID}`}
    >
      <span />
      <span>Title</span>
      <span>Tracker</span>
      <span>Due</span>
      <span>Status</span>
      <span>Spills</span>
      <span />
    </div>
  );
}

export function TaskRow({
  card,
  today,
  drawerHref,
  early = false,
}: {
  card: TaskCard;
  today: LocalDate;
  drawerHref: string;
  /** 12.3: completed early today. */
  early?: boolean;
}) {
  const status = rowStatus(card);
  const due = dueLabel(card);
  const spill = spillBadge(card);
  const doneEarly = doneEarlyLabel(card);
  const reason =
    status === "blocked" || status === "cancelled" ? rowReason(card) : null;
  const chip = (
    <TrackerChip name={card.tracker.name} color={card.tracker.color} />
  );
  const tags = (
    <>
      {spill ? (
        <span className="rounded-md bg-red-100 px-1.5 py-0.5 font-medium text-red-800 dark:bg-red-400/15 dark:text-red-300">
          {spill}
        </span>
      ) : null}
      {early ? (
        <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">
          early
        </span>
      ) : null}
      {doneEarly ? <span>{doneEarly}</span> : null}
      {reason ? <span>Reason: {reason}</span> : null}
    </>
  );

  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border bg-card p-3 sm:rounded-none sm:border-0 sm:border-b sm:bg-transparent sm:px-1 sm:py-2.5 ${ROW_GRID} ${status === "blocked" ? "opacity-75" : ""}`}
    >
      <span className="hidden sm:block">
        {card.critical ? (
          <Flame aria-label="Critical" className="size-4 text-red-600" />
        ) : null}
      </span>
      <div className="min-w-0">
        <div className="flex items-start gap-1.5">
          {card.critical ? (
            <Flame
              aria-label="Critical"
              className="mt-0.5 size-4 shrink-0 text-red-600 sm:hidden"
            />
          ) : null}
          <Link
            href={drawerHref}
            scroll={false}
            className="font-medium break-words underline-offset-2 hover:underline focus-visible:underline"
          >
            {card.title}
          </Link>
        </div>
        {card.subtitle ? (
          <p className="text-xs break-words text-muted-foreground">
            {card.subtitle}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="lg:hidden">{chip}</span>
          {due ? <span className="lg:hidden">{due}</span> : null}
          {tags}
        </div>
      </div>
      <div className="hidden min-w-0 lg:block">{chip}</div>
      <div className="hidden text-xs text-muted-foreground lg:block">{due}</div>
      <StatusControl
        taskId={card.taskId}
        title={card.title}
        status={status}
        enabled={canChange(card, today)}
        locked={card.taskDay?.locked ?? false}
        sync={card.sync}
        pull={card.taskDay !== null && card.taskDay.day > today}
      />
      <div className="flex items-center justify-between gap-2 sm:contents">
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="sm:sr-only">Spills: </span>
          {card.spillCount}
        </span>
        <a
          href={sheetRowUrl(card)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ExternalLink aria-hidden className="size-4" />
          <span className="sm:sr-only">Open in sheet</span>
        </a>
      </div>
    </li>
  );
}
