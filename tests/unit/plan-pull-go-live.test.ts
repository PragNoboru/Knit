import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { planPull, type PlanTask } from "@/lib/domain/planPull";
import { normaliseRow, type SheetRow } from "@/lib/domain/rows";

// PRD Q8 (open, section 21; N42, 6.4 rule 1, 6.6, 6.11). Go-live now defaults to the next
// working day, so between activation and go-live a live task can be re-dated in the sheet to a
// day before go-live. The PRD does not say whether it then becomes history only or keeps a
// task-day on the go-live date. Today the 6.6 "planned date moved" rule moves its open task-day
// to the new date with no attention item, and close_day locks that day not_done before go-live.
// The first test pins that behaviour so the gap is on record; the second, an expected failure,
// states the one thing any answer must give (no task-day before go-live). When Q8 is decided,
// replace both with the decided rule.
//
// The same gap applies to a backlog row brought forward before go-live (N61): its task-day sits
// on the go-live date, but its due date is still before go-live, so when the sheet re-dates it
// the 6.6 rules move the task-day before go-live again (to the new date when that is today or
// later, else to today as a spillover with past_date_added). The second describe pins that.

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

describe("a live task re-dated to before go-live (PRD Q8, open)", () => {
  it("Q8, until decided: its task-day moves to the day before go-live, with no attention item", () => {
    const p = redatedBeforeGoLive();
    expect(p.taskUpdates[0]!.set).toMatchObject({ dueDate: TODAY });
    expect(p.taskUpdates[0]!.set).not.toHaveProperty("historyOnly");
    expect(p.taskDayUpdates).toEqual([{ id: "td-1", set: { day: TODAY } }]);
    expect(p.attention).toEqual([]);
  });

  it.fails("Q8: no task-day lands before go-live", () => {
    const p = redatedBeforeGoLive();
    const days = [
      ...p.taskDayUpdates.flatMap((u) => (u.set.day ? [u.set.day] : [])),
      ...p.taskDayInserts.map((d) => d.day),
    ];
    expect(days.filter((day) => day < GO_LIVE)).toEqual([]);
  });
});

/** A backlog row brought forward before go-live (N61): due Tue 29 Sep, its task-day on go-live. */
function broughtTask(id: string): PlanTask {
  const task = liveTask(id);
  const r = normalise(row(id, "Tue 29 Sep"));
  return {
    ...task,
    plannedRaw: r.plannedRaw,
    plannedStart: "2026-09-29",
    dueDate: "2026-09-29",
    sourceSnapshot: r.snapshot,
    taskDays: [{ ...task.taskDays[0]!, spillIndex: 1, origin: "backlog" }],
  };
}

/** The sheet moves the brought task from Tue 29 Sep to Mon 28 Sep, still before go-live. */
const broughtRedated = () =>
  planPull([broughtTask("b")], [normalise(row("b", "Mon 28 Sep"))], {
    trackerId: "tracker-1",
    goLiveDate: GO_LIVE,
    today: TODAY,
    config,
  });

describe("a brought backlog task re-dated before go-live (PRD Q8, open; N61)", () => {
  it("Q8, until decided: its task-day moves from go-live to today as a spillover", () => {
    const p = broughtRedated();
    expect(p.taskUpdates[0]!.set).toMatchObject({ dueDate: "2026-09-28" });
    expect(p.taskDayUpdates).toEqual([
      { id: "td-1", set: { day: TODAY, origin: "spillover" } },
    ]);
    expect(p.attention.map((a) => a.kind)).toEqual(["past_date_added"]);
  });

  it.fails("Q8: no task-day lands before go-live", () => {
    const p = broughtRedated();
    const days = [
      ...p.taskDayUpdates.flatMap((u) => (u.set.day ? [u.set.day] : [])),
      ...p.taskDayInserts.map((d) => d.day),
    ];
    expect(days.filter((day) => day < GO_LIVE)).toEqual([]);
  });
});
