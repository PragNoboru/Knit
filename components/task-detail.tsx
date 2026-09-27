import { ExternalLink, Flame, Lock } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import {
  CorrectionButton,
  ReportIssueButton,
} from "@/components/task-day-actions";
import { TrackerChip } from "@/components/tracker-chip";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { dueLabel, sheetRowUrl } from "@/lib/domain/cards";
import {
  describeEvent,
  detailPairs,
  type TaskDetail,
} from "@/lib/domain/tasks-screens";
import { formatDay, istDateTime, type LocalDate } from "@/lib/time";

const LONG_TEXT = 160;

/**
 * PRD 12.6: title, subtitle, tracker chip, source ID, planned raw text and parsed dates, due
 * date, owner raw text, critical flag, detail columns, Open in sheet, then the task-days and
 * events. The admin sees Request correction on locked task-days; members see Report an issue.
 */
export function TaskDetailView({
  detail,
  isAdmin,
}: {
  detail: TaskDetail;
  isAdmin: boolean;
}) {
  const { card } = detail;
  const planned =
    card.plannedStart === null
      ? null
      : card.plannedEnd !== null && card.plannedEnd !== card.plannedStart
        ? `${formatDay(card.plannedStart)} to ${formatDay(card.plannedEnd)}`
        : card.dateKind === "open"
          ? `From ${formatDay(card.plannedStart)}`
          : formatDay(card.plannedStart);
  const facts: { label: string; value: React.ReactNode }[] = [
    { label: "Status", value: <StatusBadge status={card.taskStatus} /> },
    ...(card.sourceRef ? [{ label: "Source ID", value: card.sourceRef }] : []),
    {
      label: "Planned",
      value:
        [
          card.plannedRaw,
          planned && planned !== card.plannedRaw ? `(${planned})` : null,
        ]
          .filter(Boolean)
          .join(" ") || "None",
    },
    { label: "Due", value: dueLabel(card)?.replace(/^Due /, "") ?? "None" },
    ...(card.completedOn
      ? [{ label: "Completed on", value: formatDay(card.completedOn) }]
      : []),
    { label: "Owner", value: detail.ownerRaw || "None" },
    ...(card.critical
      ? [
          {
            label: "Critical",
            value: (
              <span className="inline-flex items-center gap-1">
                <Flame aria-hidden className="size-4 text-red-600" /> Yes
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-6 p-4 pt-10 sm:p-6 sm:pt-10">
      <SheetHeader className="gap-2 p-0">
        <SheetTitle className="text-lg leading-snug">{card.title}</SheetTitle>
        {card.subtitle ? (
          <SheetDescription>{card.subtitle}</SheetDescription>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <TrackerChip name={card.tracker.name} color={card.tracker.color} />
          {card.removed ? (
            <span className="text-xs text-muted-foreground">
              Removed from the sheet
            </span>
          ) : null}
          {card.historyOnly ? (
            <span className="text-xs text-muted-foreground">
              Before Knit go-live
            </span>
          ) : null}
        </div>
      </SheetHeader>

      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {facts.map((fact) => (
          <div key={fact.label} className="contents">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {detailPairs(detail).length > 0 ? (
        <section aria-label="Details">
          <h3 className="mb-2 text-sm font-semibold">Details</h3>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            {detailPairs(detail).map(({ label, value }) => (
              <div key={label} className="contents">
                <dt className="break-words text-muted-foreground">{label}</dt>
                <dd className="break-words whitespace-pre-line">
                  {value.length > LONG_TEXT ? (
                    <details>
                      <summary className="cursor-pointer">
                        {value.slice(0, LONG_TEXT)}
                        {String.fromCharCode(0x2026)}
                      </summary>
                      {value}
                    </details>
                  ) : (
                    value
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <a
        href={sheetRowUrl(card)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline"
      >
        <ExternalLink aria-hidden className="size-4" />
        Open in sheet
      </a>

      <section aria-label="Days">
        <h3 className="mb-2 text-sm font-semibold">Days</h3>
        {detail.taskDays.length === 0 ? (
          <p className="text-sm text-muted-foreground">No days yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {detail.taskDays.map((day) => (
              <li
                key={day.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="w-24 font-medium">{formatDay(day.day)}</span>
                <StatusBadge status={day.status} />
                {day.spillIndex > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Spill {day.spillIndex}
                  </span>
                ) : null}
                {day.locked ? (
                  <Lock
                    aria-label="Closed"
                    className="size-3.5 text-muted-foreground"
                  />
                ) : null}
                {day.reason ? (
                  <span className="basis-full text-xs text-muted-foreground">
                    {day.reason}
                  </span>
                ) : null}
                {day.locked ? (
                  <span className="ml-auto">
                    {isAdmin ? (
                      <CorrectionButton
                        taskDayId={day.id}
                        dayLabel={formatDay(day.day)}
                      />
                    ) : (
                      <ReportIssueButton
                        taskDayId={day.id}
                        dayLabel={formatDay(day.day)}
                      />
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="History">
        <h3 className="mb-2 text-sm font-semibold">History</h3>
        {detail.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No changes yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {[...detail.events].reverse().map((event) => {
              const { what, where, who } = describeEvent(event);
              const at = istDateTime(event.at);
              return (
                <li key={event.id} className="text-sm">
                  <p className="break-words">{what}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      who,
                      where,
                      `${formatDay(at.date as LocalDate)}, ${at.time}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
