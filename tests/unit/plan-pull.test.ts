import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import {
  planPull,
  type PlanTask,
  type PlanTaskDay,
} from "@/lib/domain/planPull";
import { normaliseRow, type SheetRow } from "@/lib/domain/rows";

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
const aliases = aliasMap([{ aliasNorm: "pragaman", userId: ME }]);
const TODAY = "2026-09-30";
const ctx = {
  trackerId: "tracker-1",
  goLiveDate: "2026-09-28",
  today: TODAY,
  config,
};

/** A Filing Buddy row. Dates are text without a year, as in the tracker. */
function row(
  knitId: string,
  over: {
    date?: string;
    status?: string;
    owner?: string;
    doneOn?: string;
    task?: string;
  } = {},
): SheetRow {
  const text = (v: string) => ({ value: v, formatted: v });
  return {
    rowNumber: 2,
    cells: {
      id: text("G21"),
      date: text(over.date ?? "Wed 30 Sep"),
      phase: text("Launch"),
      task: text(over.task ?? "Publish the staged pages"),
      owner: text(over.owner ?? "Pragaman"),
      status: text(over.status ?? "Not started"),
      "done on": text(over.doneOn ?? ""),
      "knit id": text(knitId),
    },
  };
}

const normalise = (r: SheetRow) =>
  normaliseRow(r, {
    config,
    calendar,
    aliases,
    trackerOwnerId: null,
    today: TODAY,
    knitIdHeader: "Knit ID",
  });

function taskDay(
  id: string,
  day: string,
  over: Partial<PlanTaskDay> = {},
): PlanTaskDay {
  return {
    id,
    day,
    status: "yet_to_start",
    spillIndex: 0,
    origin: "planned",
    reason: null,
    locked: false,
    ...over,
  };
}

/** The database side of the row above, as it would be after an earlier pull. */
function dbTask(id: string, over: Partial<PlanTask> = {}): PlanTask {
  const r = normalise(row(id));
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
    plannedStart: "2026-09-30",
    plannedEnd: null,
    dueDate: "2026-09-30",
    status: "yet_to_start",
    statusReason: null,
    sourceStatusRaw: r.statusRaw,
    completedOn: null,
    historyOnly: false,
    removedAtSource: false,
    sourceSnapshot: r.snapshot,
    hubChanged: false,
    assignees: [ME],
    taskDays: [taskDay("td-1", "2026-09-30")],
    ...over,
  };
}

const plan = (tasks: PlanTask[], rows: SheetRow[]) =>
  planPull(tasks, rows.map(normalise), ctx);

describe("planPull: three-way merge (PRD 10.3)", () => {
  it("source unchanged, hub unchanged: nothing", () => {
    const p = plan([dbTask("a")], [row("a")]);
    expect(p.taskUpdates).toEqual([]);
    expect(p.taskDayUpdates).toEqual([]);
    expect(p.outbox).toEqual([]);
    expect(p.attention).toEqual([]);
  });

  it("source changed, hub unchanged: the source value is applied, with an event", () => {
    const p = plan([dbTask("a")], [row("a", { status: "In progress" })]);
    expect(p.taskUpdates).toEqual([
      expect.objectContaining({
        id: "a",
        sourceSynced: true,
        set: expect.objectContaining({ status: "in_progress" }),
      }),
    ]);
    expect(p.taskDayUpdates).toEqual([
      {
        id: "td-1",
        set: { status: "in_progress", reason: null, statusChangedOn: TODAY },
      },
    ]);
    expect(p.events).toEqual([
      expect.objectContaining({
        field: "status",
        oldValue: "yet_to_start",
        newValue: "in_progress",
      }),
    ]);
  });

  it("source unchanged, hub changed: the hub value stays and its write-back is queued", () => {
    const p = plan(
      [dbTask("a", { status: "done", completedOn: TODAY, hubChanged: true })],
      [row("a")],
    );
    expect(p.taskUpdates).toEqual([]);
    expect(p.outbox).toEqual([
      { taskId: "a", statusValue: "Done", completedOn: TODAY },
    ]);
    expect(p.attention).toEqual([]);
  });

  it("both changed: the hub wins, a conflict is raised and the write-back queued", () => {
    const p = plan(
      [dbTask("a", { status: "done", completedOn: TODAY, hubChanged: true })],
      [row("a", { status: "Blocked" })],
    );
    // Only the raw word read from the sheet is recorded; the status and snapshot stay Knit's.
    expect(p.taskUpdates).toEqual([
      { id: "a", set: { sourceStatusRaw: "Blocked" }, sourceSynced: false },
    ]);
    expect(p.outbox).toHaveLength(1);
    expect(p.attention).toEqual([
      expect.objectContaining({
        kind: "conflict",
        dedupeKey: "conflict:a",
        detail: expect.objectContaining({ knit: "done", source: "blocked" }),
      }),
    ]);
  });
});

describe("planPull: changes made in the source (PRD 6.6)", () => {
  it("marked done in the sheet: done, Completed On from the sheet when not in the future", () => {
    const p = plan(
      [dbTask("a")],
      [row("a", { status: "Done", doneOn: "Tue 29 Sep" })],
    );
    expect(p.taskUpdates[0]!.set).toMatchObject({
      status: "done",
      completedOn: "2026-09-29",
    });
    const future = plan(
      [dbTask("a")],
      [row("a", { status: "Done", doneOn: "Mon 5 Oct" })],
    );
    expect(future.taskUpdates[0]!.set).toMatchObject({ completedOn: TODAY });
  });

  it("planned date moved, task open, new due date later: the open task-day moves", () => {
    const p = plan([dbTask("a")], [row("a", { date: "Mon 5 Oct" })]);
    expect(p.taskDayUpdates).toEqual([
      { id: "td-1", set: { day: "2026-10-05" } },
    ]);
    expect(p.taskUpdates[0]!.set).toMatchObject({
      dueDate: "2026-10-05",
      plannedStart: "2026-10-05",
    });
  });

  it("planned date moved into the past: the task-day stays on today as a spillover", () => {
    const task = dbTask("a", {
      dueDate: "2026-10-05",
      plannedStart: "2026-10-05",
      taskDays: [taskDay("td-1", "2026-10-05")],
    });
    const p = plan([task], [row("a", { date: "Mon 28 Sep" })]);
    expect(p.taskDayUpdates).toEqual([
      { id: "td-1", set: { day: TODAY, spillIndex: 1, origin: "spillover" } },
    ]);
    expect(p.attention).toEqual([
      expect.objectContaining({ kind: "past_date_added" }),
    ]);
  });

  it("new row with a due date already past: a spillover on today and past_date_added", () => {
    const p = plan([], [row("new", { date: "Tue 29 Sep" })]);
    expect(p.taskInserts).toEqual([
      expect.objectContaining({
        id: "new",
        dueDate: "2026-09-29",
        historyOnly: false,
      }),
    ]);
    expect(p.taskDayInserts).toEqual([
      expect.objectContaining({
        taskId: "new",
        day: TODAY,
        spillIndex: 1,
        origin: "spillover",
      }),
    ]);
    expect(p.attention).toEqual([
      expect.objectContaining({ kind: "past_date_added" }),
    ]);
  });

  it("row deleted: removed at source, open task-days cancelled, locked history untouched", () => {
    const task = dbTask("a", {
      taskDays: [
        taskDay("td-0", "2026-09-29", { status: "not_done", locked: true }),
        taskDay("td-1", TODAY),
      ],
    });
    const p = plan([task], []);
    expect(p.removals).toEqual(["a"]);
    expect(p.taskDayUpdates).toEqual([
      {
        id: "td-1",
        set: {
          status: "cancelled",
          reason: "Removed at source",
          statusChangedOn: TODAY,
        },
      },
    ]);
  });

  it("row content edited: updated in Knit, no status effect", () => {
    const p = plan(
      [dbTask("a")],
      [row("a", { task: "Publish the staged pages today" })],
    );
    expect(p.taskUpdates).toEqual([
      {
        id: "a",
        set: { title: "Publish the staged pages today" },
        sourceSynced: false,
      },
    ]);
    expect(p.taskDayUpdates).toEqual([]);
  });

  it("date cell becomes invalid: last good dates kept, bad_date raised", () => {
    const p = plan([dbTask("a")], [row("a", { date: "TBD" })]);
    expect(p.taskUpdates.flatMap((u) => Object.keys(u.set))).not.toContain(
      "dueDate",
    );
    expect(p.attention).toEqual([
      expect.objectContaining({
        kind: "bad_date",
        detail: expect.objectContaining({ reason: "unparseable" }),
      }),
    ]);
  });
});

describe("planPull: new rows (PRD 6.3, 6.4, 6.11, N9)", () => {
  it("a future row gets one planned task-day on its due date", () => {
    const p = plan([], [row("n", { date: "Mon 5 Oct" })]);
    expect(p.taskDayInserts).toEqual([
      {
        taskId: "n",
        day: "2026-10-05",
        status: "yet_to_start",
        spillIndex: 0,
        origin: "planned",
        reason: null,
        statusChangedOn: null,
      },
    ]);
    expect(p.assigneeSets).toEqual([{ taskId: "n", userIds: [ME] }]);
  });

  it("a row planned before go-live is history only, with no task-day", () => {
    const p = plan([], [row("h", { date: "Mon 21 Sep" })]);
    expect(p.taskInserts).toEqual([
      expect.objectContaining({ historyOnly: true }),
    ]);
    expect(p.taskDayInserts).toEqual([]);
  });

  it("an open-ended row has no task-day until completed (N9)", () => {
    expect(
      plan([], [row("o", { date: "From 30 Oct" })]).taskDayInserts,
    ).toEqual([]);
    expect(
      plan([], [row("o", { date: "From 30 Oct", status: "Done" })])
        .taskDayInserts,
    ).toEqual([
      expect.objectContaining({
        day: TODAY,
        status: "done",
        origin: "completion",
      }),
    ]);
  });

  it("an invalid date skips the row and reports it; an empty date skips it silently", () => {
    const invalid = plan([], [row("x", { date: "Sat 28 Sep" })]);
    expect(invalid.taskInserts).toEqual([]);
    expect(invalid.attention).toEqual([
      expect.objectContaining({
        kind: "bad_date",
        detail: expect.objectContaining({ reason: "weekday_mismatch" }),
      }),
    ]);
    const empty = plan([], [row("y", { date: "" })]);
    expect(empty.taskInserts).toEqual([]);
    expect(empty.attention).toEqual([]);
  });

  it("raises one item per unmapped word and per unknown owner, never per row", () => {
    const p = plan(
      [],
      [
        row("a", { status: "Copy ready", owner: "Creative" }),
        row("b", { status: "copy  ready", owner: "creative" }),
      ],
    );
    expect(p.attention.map((a) => a.dedupeKey).sort()).toEqual([
      "unknown_owner:creative",
      "unmapped_status:copy ready",
    ]);
    expect(p.taskInserts.map((t) => t.status)).toEqual([
      "yet_to_start",
      "yet_to_start",
    ]);
  });
});
