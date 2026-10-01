import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { planPull, type PlanTask } from "@/lib/domain/planPull";
import { normaliseRow, type SheetRow } from "@/lib/domain/rows";

// OPEN QUESTION for Pragaman (N42, 6.4 rule 1, 6.6, 6.11). Go-live now defaults to the next
// working day, so between activation and go-live a live task can be re-dated in the sheet to a
// day before go-live. The PRD does not say whether it then becomes history only or keeps a
// task-day on the go-live date. Today the 6.6 "planned date moved" rule moves its open task-day
// to the new date with no attention item, and close_day locks that day not_done before go-live.
// The first test pins that behaviour so the gap is on record; the second, an expected failure,
// states the one thing any answer must give (no task-day before go-live). When the PRD decides,
// replace both with the decided rule.

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;

const config = TrackerConfig.parse(
  read<{ trackers: Record<string, unknown>[] }>(
    "trackers.config.json",
  ).trackers.find((t) => t.name === "Filing Buddy · Google Ads"),
);
const calendar = calendarFromDays(
  calendarDaysFromRules(
    read<{ holidays: { date: string; name: string }[] }>("holidays.json")
      .holidays,
    "2026-01-01",
    "2027-12-31",
  ),
);
const ME = "user-pragaman";
const TODAY = "2026-09-30"; // Wed: activated today with the default go-live
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)

/** A Filing Buddy row. Dates are text without a year, as in the tracker. */
function row(knitId: string, date: string): SheetRow {
  const text = (v: string) => ({ value: v, formatted: v });
  return {
    rowNumber: 2,
    cells: {
      id: text("G21"),
      date: text(date),
      phase: text("Launch"),
      task: text("Publish the staged pages"),
      owner: text("Pragaman"),
      status: text("Not started"),
      "done on": text(""),
      "knit id": text(knitId),
    },
  };
}

const normalise = (r: SheetRow) =>
  normaliseRow(r, {
    config,
    calendar,
    aliases: aliasMap([{ aliasNorm: "pragaman", userId: ME }]),
    trackerOwnerId: null,
    today: TODAY,
    knitIdHeader: "Knit ID",
  });

/** A live task due on the go-live day, with its planned task-day there, as the first pull made it. */
function liveTask(id: string): PlanTask {
  const r = normalise(row(id, "Thu 1 Oct"));
  return {
    id,
    title: r.title,
    subtitle: r.subtitle,
    details: r.details,
    sourceRef: r.sourceRef,
    critical: r.critical,
    ownerRaw: r.ownerRaw,
    plannedRaw: r.plannedRaw,
    rowHint: r.rowNumber,
    dateKind: "single",
    plannedStart: GO_LIVE,
    plannedEnd: null,
    dueDate: GO_LIVE,
    status: "yet_to_start",
    statusReason: null,
    sourceStatusRaw: r.statusRaw,
    completedOn: null,
    historyOnly: false,
    removedAtSource: false,
    sourceSnapshot: r.snapshot,
    hubChanged: false,
    assignees: [ME],
    taskDays: [
      {
        id: "td-1",
        day: GO_LIVE,
        status: "yet_to_start",
        spillIndex: 0,
        origin: "planned",
        reason: null,
        locked: false,
      },
    ],
  };
}

/** The sheet moves the task from Thu 1 Oct (go-live) to Wed 30 Sep (today), before go-live. */
const redatedBeforeGoLive = () =>
  planPull([liveTask("a")], [normalise(row("a", "Wed 30 Sep"))], {
    trackerId: "tracker-1",
    goLiveDate: GO_LIVE,
    today: TODAY,
    config,
  });

describe("a live task re-dated to before go-live (N42: open question, no PRD rule yet)", () => {
  it("today: its task-day moves to the day before go-live, with no attention item", () => {
    const p = redatedBeforeGoLive();
    expect(p.taskUpdates[0]!.set).toMatchObject({ dueDate: TODAY });
    expect(p.taskUpdates[0]!.set).not.toHaveProperty("historyOnly");
    expect(p.taskDayUpdates).toEqual([{ id: "td-1", set: { day: TODAY } }]);
    expect(p.attention).toEqual([]);
  });

  it.fails("wanted: no task-day lands before go-live", () => {
    const p = redatedBeforeGoLive();
    const days = [
      ...p.taskDayUpdates.flatMap((u) => (u.set.day ? [u.set.day] : [])),
      ...p.taskDayInserts.map((d) => d.day),
    ];
    expect(days.filter((day) => day < GO_LIVE)).toEqual([]);
  });
});
