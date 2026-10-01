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

/** The row normalised on another day, or under another registry. */
const normaliseWith = (
  r: SheetRow,
  over: { today?: string; config?: TrackerConfig } = {},
) =>
  normaliseRow(r, {
    config: over.config ?? config,
    calendar,
    aliases,
    trackerOwnerId: null,
    today: over.today ?? TODAY,
    knitIdHeader: "Knit ID",
  });

/** The task as apply_pull_plan leaves it after a plan's task update. */
function afterPlan(task: PlanTask, p: ReturnType<typeof planPull>): PlanTask {
  const update = p.taskUpdates.find((u) => u.id === task.id);
  return { ...task, ...update?.set } as PlanTask;
}

describe("planPull: a status word mapped after it was read (PRD 6.8, N19 d, 10.3)", () => {
  const mapped = TrackerConfig.parse({
    ...config,
    statusMap: { ...config.statusMap, "copy ready": "done" },
  });
  const copyReady = row("a", { status: "Copy ready" });

  /** Pull 1: the unmapped word arrives, the task is stored as Yet to Start (6.8). */
  function storedUnmapped(over: Partial<PlanTask> = {}): PlanTask {
    const first = plan([dbTask("a")], [copyReady]);
    expect(first.attention).toEqual([
      expect.objectContaining({ dedupeKey: "unmapped_status:copy ready" }),
    ]);
    // N28: the snapshot records that the word was unmapped when read.
    expect(first.taskUpdates[0]?.set.sourceSnapshot).toEqual({
      statusKey: "copy ready",
      status: null,
      completedOn: null,
    });
    return { ...afterPlan(dbTask("a"), first), ...over };
  }

  it("Map status then pull again: the new mapping reaches the task and its open task-day", () => {
    const task = storedUnmapped();
    const p = planPull([task], [normaliseWith(copyReady, { config: mapped })], {
      ...ctx,
      config: mapped,
    });
    expect(p.taskUpdates).toEqual([
      expect.objectContaining({
        id: "a",
        sourceSynced: true,
        set: expect.objectContaining({
          status: "done",
          completedOn: TODAY,
          sourceSnapshot: {
            statusKey: "copy ready",
            status: "done",
            completedOn: null,
          },
        }),
      }),
    ]);
    expect(p.taskDayUpdates).toEqual([
      {
        id: "td-1",
        set: { status: "done", reason: null, statusChangedOn: TODAY },
      },
    ]);
    expect(p.events).toEqual([
      expect.objectContaining({
        field: "status",
        oldValue: "yet_to_start",
        newValue: "done",
      }),
    ]);

    // Pulling again changes nothing (invariant 8).
    const again = planPull(
      [afterPlan(task, p)],
      [normaliseWith(copyReady, { config: mapped })],
      { ...ctx, config: mapped },
    );
    expect(again.taskUpdates).toEqual([]);
    expect(again.events).toEqual([]);
  });

  it("a status changed in Knit meanwhile still wins, with a conflict (10.3)", () => {
    const task = storedUnmapped({ status: "in_progress", hubChanged: true });
    const p = planPull([task], [normaliseWith(copyReady, { config: mapped })], {
      ...ctx,
      config: mapped,
    });
    expect(p.taskUpdates.flatMap((u) => Object.keys(u.set))).not.toContain(
      "status",
    );
    expect(p.attention).toEqual([
      expect.objectContaining({
        kind: "conflict",
        detail: expect.objectContaining({
          knit: "in_progress",
          source: "done",
        }),
      }),
    ]);
  });

  it("a status changed in Knit and settled (N8: Blocked is not written) still wins, with a conflict raised once (N60)", () => {
    // Knit set Blocked; the push left the unmapped word and its null snapshot, hub change cleared.
    const task = storedUnmapped({ status: "blocked", hubChanged: false });
    for (const word of ["done", "yet_to_start"] as const) {
      const cfg = TrackerConfig.parse({
        ...config,
        statusMap: { ...config.statusMap, "copy ready": word },
      });
      const pullUnder = (t: PlanTask) =>
        planPull([t], [normaliseWith(copyReady, { config: cfg })], {
          ...ctx,
          config: cfg,
        });
      const p = pullUnder(task);
      expect(p.taskUpdates).toEqual([
        {
          id: "a",
          sourceSynced: true,
          set: {
            sourceSnapshot: {
              statusKey: "copy ready",
              status: word,
              completedOn: null,
            },
          },
        },
      ]);
      expect(p.taskDayUpdates).toEqual([]);
      expect(p.events).toEqual([]);
      expect(p.outbox).toEqual([]);
      expect(p.attention).toEqual([
        expect.objectContaining({
          kind: "conflict",
          taskId: "a",
          detail: { knit: "blocked", source: word, sourceWord: "Copy ready" },
        }),
      ]);
      expect(p.stats.conflicts).toBe(1);

      // The next pull sees the word as read: no change, no second conflict (invariant 8).
      const again = pullUnder(afterPlan(task, p));
      expect(again.taskUpdates).toEqual([]);
      expect(again.attention).toEqual([]);
    }
  });

  it("mapped to the status Knit already set: no conflict, the mapping is recorded (N60)", () => {
    const task = storedUnmapped({ status: "blocked" });
    const cfg = TrackerConfig.parse({
      ...config,
      statusMap: { ...config.statusMap, "copy ready": "blocked" },
    });
    const p = planPull([task], [normaliseWith(copyReady, { config: cfg })], {
      ...ctx,
      config: cfg,
    });
    expect(p.attention).toEqual([]);
    expect(p.events).toEqual([]);
    expect(p.taskUpdates).toEqual([
      {
        id: "a",
        sourceSynced: true,
        set: {
          sourceSnapshot: {
            statusKey: "copy ready",
            status: "blocked",
            completedOn: null,
          },
        },
      },
    ]);
  });

  it("a first mapping with another sheet edit beside it is applied from the sheet (10.3)", () => {
    const task = storedUnmapped({ status: "blocked" });
    const p = planPull(
      [task],
      [
        normaliseWith(
          row("a", { status: "Copy ready", doneOn: "Tue 29 Sep" }),
          {
            config: mapped,
          },
        ),
      ],
      { ...ctx, config: mapped },
    );
    expect(p.taskUpdates[0]?.set).toMatchObject({
      status: "done",
      completedOn: "2026-09-29",
    });
    expect(p.attention).toEqual([]);
  });

  it("a snapshot without the mapped status (saved by the push) compares the word only", () => {
    // N8: Knit set In progress, which the tracker cannot write; the push saved the word.
    const task = dbTask("a", {
      status: "in_progress",
      sourceSnapshot: { statusKey: "not started", completedOn: null },
    });
    expect(plan([task], [row("a")]).taskUpdates).toEqual([]);
  });

  it("a word recorded as unmapped and still unmapped: a completed-on edit applies Yet to Start and tells (6.8)", () => {
    const task = storedUnmapped();
    const p = plan(
      [task],
      [row("a", { status: "Copy ready", doneOn: "Tue 29 Sep" })],
    );
    expect(p.taskUpdates).toEqual([
      expect.objectContaining({
        set: expect.objectContaining({
          status: "yet_to_start",
          sourceSnapshot: {
            statusKey: "copy ready",
            status: null,
            completedOn: "2026-09-29",
          },
        }),
      }),
    ]);
    expect(p.attention).toEqual([
      expect.objectContaining({ dedupeKey: "unmapped_status:copy ready" }),
    ]);
    expect(p.events).toEqual([]);
  });
});

describe("normaliseRow: the snapshot records the status read (N28)", () => {
  it("null for an unmapped word, the mapped status otherwise", () => {
    expect(normalise(row("a", { status: "Copy ready" })).snapshot).toEqual({
      statusKey: "copy ready",
      status: null,
      completedOn: null,
    });
    expect(normalise(row("a", { status: "Done" })).snapshot).toEqual({
      statusKey: "done",
      status: "done",
      completedOn: null,
    });
  });
});

describe("planPull: a remapped word applies to later edits only (N28)", () => {
  /** Under A "copy ready" means Done; the admin then remaps it to In Progress (B). */
  const A = TrackerConfig.parse({
    ...config,
    statusMap: { ...config.statusMap, "copy ready": "done" },
  });
  const B = TrackerConfig.parse({
    ...config,
    statusMap: { ...config.statusMap, "copy ready": "in_progress" },
  });
  const under = (
    cfg: TrackerConfig,
    tasks: PlanTask[],
    rows: SheetRow[],
  ): ReturnType<typeof planPull> =>
    planPull(
      tasks,
      rows.map((r) => normaliseWith(r, { config: cfg })),
      { ...ctx, config: cfg },
    );
  /** The task and its task-days as apply_pull_plan leaves them. */
  const applied = (task: PlanTask, p: ReturnType<typeof planPull>) => {
    const next = afterPlan(task, p);
    return {
      ...next,
      taskDays: next.taskDays.map((d) => {
        const update = p.taskDayUpdates.find((u) => u.id === d.id);
        return update ? { ...d, ...update.set } : d;
      }),
    };
  };
  const copyReady = (over: { doneOn?: string } = {}) =>
    row("a", { status: "Copy ready", ...over });

  /** Pull under A: the task takes "Copy ready" as Done. */
  function storedDone(over: Partial<PlanTask> = {}): PlanTask {
    const p = under(A, [dbTask("a")], [copyReady()]);
    const task = applied(dbTask("a"), p);
    expect(task.status).toBe("done");
    expect(task.sourceSnapshot).toEqual({
      statusKey: "copy ready",
      status: "done",
      completedOn: null,
    });
    return { ...task, ...over };
  }

  it("the sheet unchanged: nothing changes, and a second pull is the same", () => {
    const task = storedDone();
    for (let i = 0; i < 2; i += 1) {
      const p = under(B, [task], [copyReady()]);
      expect(p.taskUpdates).toEqual([]);
      expect(p.taskDayUpdates).toEqual([]);
      expect(p.events).toEqual([]);
      expect(p.attention).toEqual([]);
      expect(p.outbox).toEqual([]);
    }
  });

  it("changed in Knit meanwhile, word unchanged: no conflict, the write-back stays queued", () => {
    const task = storedDone({ status: "in_progress", hubChanged: true });
    const p = under(B, [task], [copyReady()]);
    expect(p.attention).toEqual([]);
    expect(p.stats.conflicts).toBe(0);
    expect(p.outbox).toEqual([
      {
        taskId: "a",
        statusValue: "In progress",
        completedOn: task.completedOn,
      },
    ]);
  });

  it("the word changes and then changes back: the last pull applies the new meaning", () => {
    const task = storedDone();
    const toNotStarted = under(B, [task], [row("a")]);
    expect(toNotStarted.taskUpdates[0]?.set.status).toBe("yet_to_start");
    const back = under(B, [applied(task, toNotStarted)], [copyReady()]);
    expect(back.taskUpdates).toEqual([
      expect.objectContaining({
        set: expect.objectContaining({
          status: "in_progress",
          sourceSnapshot: {
            statusKey: "copy ready",
            status: "in_progress",
            completedOn: null,
          },
        }),
      }),
    ]);
    expect(back.events).toEqual([
      expect.objectContaining({
        oldValue: "yet_to_start",
        newValue: "in_progress",
      }),
    ]);
  });

  it("a new row with the remapped word takes the new meaning", () => {
    const p = under(B, [], [row("b", { status: "Copy ready" })]);
    expect(p.taskInserts).toEqual([
      expect.objectContaining({
        id: "b",
        status: "in_progress",
        sourceSnapshot: {
          statusKey: "copy ready",
          status: "in_progress",
          completedOn: null,
        },
      }),
    ]);
  });

  it("only Completed On changes: the recorded status is applied with it", () => {
    const task = storedDone();
    const p = under(B, [task], [copyReady({ doneOn: "Tue 29 Sep" })]);
    expect(p.taskUpdates).toEqual([
      expect.objectContaining({
        set: expect.objectContaining({
          status: "done",
          completedOn: "2026-09-29",
          sourceSnapshot: {
            statusKey: "copy ready",
            status: "done",
            completedOn: "2026-09-29",
          },
        }),
      }),
    ]);
    expect(p.events).toEqual([]);
  });

  it("a word removed from the map is not held: a completed-on edit never keeps Done (invariant 7)", () => {
    const task = storedDone();
    const removed = TrackerConfig.parse({
      ...config,
      statusMap: Object.fromEntries(
        Object.entries(A.statusMap).filter(([word]) => word !== "copy ready"),
      ),
    });
    const p = under(removed, [task], [copyReady({ doneOn: "Tue 29 Sep" })]);
    expect(p.taskUpdates[0]?.set).toMatchObject({
      status: "yet_to_start",
      completedOn: null,
      sourceSnapshot: {
        statusKey: "copy ready",
        status: null,
        completedOn: "2026-09-29",
      },
    });
    expect(p.attention).toEqual([
      expect.objectContaining({ dedupeKey: "unmapped_status:copy ready" }),
    ]);
  });

  it("a held Cancelled keeps its reason when the remapped word has no cancel reason (D2)", () => {
    const C = TrackerConfig.parse({
      ...config,
      statusMap: { ...config.statusMap, moved: "cancelled" },
      cancelReasons: { moved: "Moved" },
    });
    // As saveStatuses saves it: no cancelReasons entry for a word not mapped to Cancelled.
    const D = TrackerConfig.parse({
      ...config,
      statusMap: { ...config.statusMap, moved: "yet_to_start" },
      cancelReasons: {},
    });
    const first = under(C, [dbTask("a")], [row("a", { status: "Moved" })]);
    const task = applied(dbTask("a"), first);
    expect(task).toMatchObject({ status: "cancelled", statusReason: "Moved" });

    const p = under(
      D,
      [task],
      [row("a", { status: "Moved", doneOn: "Tue 29 Sep" })],
    );
    expect(p.taskUpdates).toHaveLength(1);
    const set = p.taskUpdates[0]!.set;
    expect(set.status).toBe("cancelled");
    expect(set).not.toHaveProperty("statusReason");
    expect(set.sourceSnapshot).toEqual({
      statusKey: "moved",
      status: "cancelled",
      completedOn: "2026-09-29",
    });
    expect(p.events).toEqual([]);
    expect(p.taskDayUpdates.map((u) => u.set.reason)).not.toContain(null);
  });
});

describe("planPull: planned dates moved in the source (PRD 6.6)", () => {
  it("a date moved while yesterday's task-day waits for its close moves the spillover the close makes", () => {
    const today = "2026-10-01";
    const moved = normaliseWith(row("a", { date: "Mon 5 Oct" }), { today });
    // The close's forced pull (10.5): Wed 30 Sep is not closed yet.
    const task = dbTask("a");
    const first = planPull([task], [moved], { ...ctx, today });
    expect(first.taskDayUpdates).toEqual([]);

    // close_day(30 Sep): locked Not Done, a spillover on Thu 1 Oct (6.4).
    const closed: PlanTask = {
      ...afterPlan(task, first),
      taskDays: [
        taskDay("td-1", "2026-09-30", { status: "not_done", locked: true }),
        taskDay("td-2", today, { spillIndex: 1, origin: "spillover" }),
      ],
    };
    const second = planPull([closed], [moved], { ...ctx, today });
    expect(second.taskDayUpdates).toEqual([
      { id: "td-2", set: { day: "2026-10-05" } },
    ]);
    expect(second.taskUpdates[0]!.set).toMatchObject({
      dueDate: "2026-10-05",
      plannedStart: "2026-10-05",
    });
    expect(second.events).toEqual([
      expect.objectContaining({
        field: "due_date",
        oldValue: "2026-09-30",
        newValue: "2026-10-05",
      }),
    ]);
  });

  it("a date moved into the past while the task-day is on today: it turns into a spillover", () => {
    const p = plan([dbTask("a")], [row("a", { date: "Mon 28 Sep" })]);
    expect(p.taskDayUpdates).toEqual([
      { id: "td-1", set: { spillIndex: 1, origin: "spillover" } },
    ]);
    expect(p.attention).toEqual([
      expect.objectContaining({
        kind: "past_date_added",
        detail: { dueDate: "2026-09-28" },
      }),
    ]);
    expect(p.events).toEqual([
      expect.objectContaining({
        field: "due_date",
        oldValue: "2026-09-30",
        newValue: "2026-09-28",
      }),
    ]);
  });
});

describe("planPull: a row carrying a removed task's Knit ID (N30, N59)", () => {
  const cancelled = (day: string, locked: boolean) =>
    taskDay("td-1", day, {
      status: "cancelled",
      reason: "Removed at source",
      locked,
    });
  const removed = (day: string, locked: boolean) =>
    dbTask("a", {
      dueDate: day,
      plannedStart: day,
      removedAtSource: true,
      taskDays: [cancelled(day, locked)],
    });

  /** The removed task is left exactly as it is: nothing in the plan but the skipped row. */
  function expectSkipped(p: ReturnType<typeof planPull>) {
    expect(p.taskInserts).toEqual([]);
    expect(p.taskUpdates).toEqual([]);
    expect(p.taskDayInserts).toEqual([]);
    expect(p.taskDayUpdates).toEqual([]);
    expect(p.assigneeSets).toEqual([]);
    expect(p.removals).toEqual([]);
    expect(p.outbox).toEqual([]);
    expect(p.events).toEqual([]);
    expect(p.attention).toEqual([]);
    expect(p.stats).toMatchObject({
      rows: 1,
      inserted: 0,
      updated: 0,
      removed: 0,
      skipped: 1,
    });
  }

  it("with a cancelled open task-day on the same day: skipped, never restored", () => {
    expectSkipped(plan([removed(TODAY, false)], [row("a")]));
  });

  it("with a cancelled locked task-day: skipped, no restored_after_close item", () => {
    expectSkipped(
      plan([removed("2026-10-05", true)], [row("a", { date: "Mon 5 Oct" })]),
    );
  });

  it("with a date Knit cannot read: skipped, no bad_date item", () => {
    expectSkipped(
      plan([removed("2026-10-05", true)], [row("a", { date: "TBD" })]),
    );
  });

  it("with an unmapped status word and an unknown owner: skipped before any row attention", () => {
    expectSkipped(
      plan(
        [removed(TODAY, false)],
        [row("a", { status: "Copy ready", owner: "Creative" })],
      ),
    );
  });

  it("no plan carries a restored_after_close item or a removedAtSource key", () => {
    const p = plan(
      [removed("2026-09-29", true)],
      [row("a", { date: "Tue 29 Sep" })],
    );
    expect(JSON.stringify(p)).not.toContain("restored_after_close");
    for (const update of p.taskUpdates)
      expect(Object.keys(update.set)).not.toContain("removedAtSource");
  });

  it("a removed task whose row is absent is not removed again", () => {
    const p = plan([removed(TODAY, false)], []);
    expect(p.removals).toEqual([]);
    expect(p.events).toEqual([]);
    expect(p.stats.removed).toBe(0);
  });
});
