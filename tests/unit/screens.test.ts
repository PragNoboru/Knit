import { describe, expect, it } from "vitest";

import { buildBanners, type BannersData } from "@/lib/domain/banners";
import {
  canChange,
  compareCards,
  doneEarlyLabel,
  dueLabel,
  sheetRowUrl,
  spillBadge,
  TaskCard,
  type TaskDayInfo,
} from "@/lib/domain/cards";
import type { KnitStatus } from "@/lib/domain/config";
import {
  buildDayView,
  dayHeader,
  DayViewData,
  noticeText,
} from "@/lib/domain/day-view";
import { dayColour, monthGrid, type MonthDay } from "@/lib/domain/month-view";
import { messageFor } from "@/lib/errors";
import { addMonths, istDateTime, startOfMonth } from "@/lib/time";

// PRD 12.3, 12.4, 12.7 (M7): the rules behind the screens.

const TRACKER_A = "00000000-0000-4000-8000-00000000000a";
const TRACKER_B = "00000000-0000-4000-8000-00000000000b";
let counter = 0;

function card(
  over: Partial<Omit<TaskCard, "taskDay">> & {
    taskDay?: Partial<TaskDayInfo> | null;
  } = {},
): TaskCard {
  counter += 1;
  const { taskDay, ...rest } = over;
  return TaskCard.parse({
    taskId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    title: `Task ${counter}`,
    subtitle: null,
    critical: false,
    dueDate: "2026-09-24",
    plannedStart: "2026-09-24",
    plannedEnd: null,
    plannedRaw: "Thu 24 Sep",
    dateKind: "single",
    taskStatus: "yet_to_start",
    taskReason: null,
    completedOn: null,
    sourceRef: null,
    rowHint: 5,
    historyOnly: false,
    removed: false,
    tracker: {
      id: TRACKER_A,
      name: "Filing Buddy",
      color: "amber",
      fileId: "file-1",
      gid: 0,
    },
    sync: null,
    spillCount: 0,
    editable: true,
    ...rest,
    taskDay:
      taskDay === null
        ? null
        : {
            id: counter,
            day: "2026-09-24",
            status: "yet_to_start",
            spillIndex: 0,
            reason: null,
            locked: false,
            carriedStatus: null,
            statusChangedOn: null,
            origin: "planned",
            ...taskDay,
          },
  });
}

const onDay = (status: KnitStatus, extra: Partial<TaskDayInfo> = {}) =>
  card({ taskDay: { status, ...extra } });

function dayData(over: Partial<DayViewData> = {}): DayViewData {
  return DayViewData.parse({
    day: "2026-09-24",
    today: "2026-09-24",
    isWorking: true,
    offReason: null,
    nextWorkingDay: "2026-09-25",
    isAdmin: false,
    hasTasks: true,
    hasTrackers: true,
    adminContact: { name: "Pragaman", email: "admin@example.com" },
    rows: [],
    ongoing: [],
    pulledForward: [],
    earlyDone: [],
    upcoming: [],
    nextDayRows: [],
    ...over,
  });
}

const titles = (view: ReturnType<typeof buildDayView>) =>
  view.groups.map((g) => [g.title, g.rows.map((r) => r.card.title)]);

describe("Today header (12.3)", () => {
  it("counts done of the day's task-days without the cancelled ones, and spillovers", () => {
    const rows = [
      ...[1, 2, 3, 4].map(() => onDay("done")),
      onDay("cancelled"),
      onDay("yet_to_start", { spillIndex: 1 }),
      onDay("in_progress", { spillIndex: 2 }),
      onDay("yet_to_start"),
      onDay("blocked", { reason: "Waiting" }),
      onDay("in_progress"),
    ];
    expect(dayHeader("2026-09-24", rows)).toBe(
      "Thu 24 Sep · 4 of 9 done · 2 spilled in",
    );
  });

  it("leaves out counts that are zero (N18)", () => {
    expect(dayHeader("2026-09-27", [])).toBe("Sun 27 Sep");
    expect(dayHeader("2026-09-24", [onDay("done")])).toBe(
      "Thu 24 Sep · 1 of 1 done",
    );
  });
});

describe("Today groups (12.3)", () => {
  it("puts each task in its group, in the PRD order, with Done today collapsed", () => {
    const spill = card({
      title: "Spilled",
      taskDay: { spillIndex: 2, status: "in_progress" },
    });
    const due = card({ title: "Due" });
    const blockedSpill = card({
      title: "Blocked",
      taskDay: { status: "blocked", spillIndex: 1, reason: "Waiting" },
    });
    const done = card({ title: "Done", taskDay: { status: "done" } });
    const cancelled = card({
      title: "Cancelled",
      taskDay: { status: "cancelled", reason: "Not needed" },
    });
    const ongoing = card({
      title: "Window",
      dateKind: "window",
      plannedStart: "2026-09-21",
      dueDate: "2026-09-28",
      taskDay: null,
    });
    const pulled = card({
      title: "Pulled",
      dueDate: "2026-10-05",
      taskDay: { day: "2026-10-05", status: "in_progress" },
    });
    const early = card({
      title: "Early",
      dueDate: "2026-10-06",
      taskDay: {
        day: "2026-10-06",
        status: "done",
        statusChangedOn: "2026-09-24",
      },
    });
    const view = buildDayView(
      dayData({
        rows: [done, blockedSpill, due, cancelled, spill],
        ongoing: [ongoing],
        pulledForward: [pulled],
        earlyDone: [early],
      }),
    );
    expect(titles(view)).toEqual([
      ["Spillover", ["Spilled"]],
      ["Due today", ["Due"]],
      ["Ongoing", ["Window"]],
      ["Pulled forward", ["Pulled"]],
      ["Blocked", ["Blocked"]],
      ["Done today", ["Cancelled", "Done", "Early"]],
    ]);
    const doneGroup = view.groups.at(-1)!;
    expect(doneGroup.collapsed).toBe(true);
    expect(doneGroup.rows.map((r) => r.early)).toEqual([false, false, true]);
    expect(view.groups.slice(0, -1).every((g) => !g.collapsed)).toBe(true);
    expect(view.notice).toBeNull();
  });

  it("shows a task once: a window in progress stays under Ongoing (N18)", () => {
    const window = card({
      title: "Window",
      dateKind: "window",
      taskStatus: "in_progress",
      dueDate: "2026-09-30",
      taskDay: null,
    });
    const itsDay = { ...window, taskDay: onDay("in_progress").taskDay };
    const view = buildDayView(
      dayData({
        rows: [onDay("yet_to_start")],
        ongoing: [window],
        pulledForward: [itsDay],
      }),
    );
    expect(view.groups.map((g) => g.key)).toEqual(["due", "ongoing"]);
  });

  it("sorts inside a group: critical, due date, tracker name, title", () => {
    const rows = [
      card({ title: "b", tracker: { ...card().tracker, name: "Zeta" } }),
      card({ title: "late", dueDate: "2026-09-30" }),
      card({ title: "crit", critical: true, dueDate: "2026-10-30" }),
      card({ title: "a", tracker: { ...card().tracker, name: "Zeta" } }),
      card({ title: "z", tracker: { ...card().tracker, name: "Alpha" } }),
    ];
    expect(rows.sort(compareCards).map((c) => c.title)).toEqual([
      "crit",
      "z",
      "a",
      "b",
      "late",
    ]);
  });

  it("on an off day hides windows but keeps open-ended tasks under Ongoing (6.3.3, N4)", () => {
    const window = card({
      title: "Window",
      dateKind: "window",
      plannedStart: "2026-09-21",
      dueDate: "2026-09-30",
      taskDay: null,
    });
    const open = card({
      title: "Open",
      dateKind: "open",
      dueDate: null,
      taskDay: null,
    });
    const view = buildDayView(
      dayData({
        day: "2026-09-27",
        today: "2026-09-27",
        isWorking: false,
        offReason: "Sunday",
        ongoing: [window, open],
      }),
    );
    expect(titles(view)).toEqual([["Ongoing", ["Open"]]]);
    expect(noticeText(view.notice!)).toBe(
      "Day off (Sunday). Nothing is due or spills here.",
    );
  });

  it("a past day shows only its own task-days, not early completions (N18 a)", () => {
    const early = card({
      title: "Early",
      dueDate: "2026-09-30",
      taskDay: {
        day: "2026-09-30",
        status: "done",
        statusChangedOn: "2026-09-24",
      },
    });
    const past = buildDayView(
      dayData({
        day: "2026-09-24",
        today: "2026-09-28",
        rows: [onDay("not_done", { locked: true })],
        earlyDone: [early],
      }),
    );
    expect(past.when).toBe("past");
    expect(
      past.groups.flatMap((g) => g.rows.map((r) => r.card.title)),
    ).not.toContain("Early");
    // Today still lists it in Done today, tagged early (6.5).
    const today = buildDayView(
      dayData({ rows: [onDay("yet_to_start")], earlyDone: [early] }),
    );
    expect(today.groups.at(-1)!.rows).toEqual([{ card: early, early: true }]);
  });

  it("titles other days without 'today' (N18)", () => {
    const view = buildDayView(
      dayData({
        day: "2026-09-22",
        rows: [onDay("not_done", { day: "2026-09-22", locked: true })],
      }),
    );
    expect(view.when).toBe("past");
    expect(view.groups.map((g) => g.title)).toEqual(["Due"]);
  });

  it("filters by tracker and status", () => {
    const a = onDay("yet_to_start");
    const b = card({
      tracker: { ...card().tracker, id: TRACKER_B, name: "Sapiens" },
    });
    const view = buildDayView(dayData({ rows: [a, b] }), {
      trackerIds: [TRACKER_B],
      statuses: [],
    });
    expect(view.groups.flatMap((g) => g.rows.map((r) => r.card))).toEqual([b]);
    const none = buildDayView(dayData({ rows: [a, b] }), {
      trackerIds: [],
      statuses: ["blocked"],
    });
    expect(noticeText(none.notice!)).toBe("No tasks match these filters.");
    // The header always counts every task-day of the day.
    expect(none.header).toBe("Thu 24 Sep · 0 of 2 done");
  });
});

describe("empty and edge states (12.7)", () => {
  const text = (data: Partial<DayViewData>) =>
    noticeText(buildDayView(dayData(data)).notice!);

  it("uses the PRD copy", () => {
    expect(text({})).toBe("Nothing is planned for today.");
    expect(text({ rows: [onDay("done"), onDay("cancelled")] })).toBe(
      "All clear for today. 1 task done.",
    );
    expect(
      text({
        rows: [onDay("done"), onDay("done")],
        earlyDone: [onDay("done", { day: "2026-10-01" })],
      }),
    ).toBe("All clear for today. 3 tasks done.");
    expect(
      text({ isWorking: false, offReason: "2nd Saturday", day: "2026-09-26" }),
    ).toBe("Day off (2nd Saturday). Nothing is due or spills here.");
    expect(text({ day: "2026-09-23" })).toBe(
      "Nothing was scheduled on this day.",
    );
    expect(text({ day: "2026-09-25" })).toBe(
      "Nothing is planned for this day.",
    );
    expect(text({ hasTasks: false })).toBe(
      "No trackers are connected to your account yet.",
    );
    expect(text({ isAdmin: true, hasTrackers: false, hasTasks: false })).toBe(
      "Connect your first tracker.",
    );
  });

  it("offers the next three tasks when nothing is planned, and tomorrow when all is clear", () => {
    const upcoming = [card(), card(), card()];
    expect(buildDayView(dayData({ upcoming })).notice).toEqual({
      kind: "nothing_planned",
      upcoming,
    });
    const tomorrow = [card({ critical: true }), card()];
    const clear = buildDayView(
      dayData({ rows: [onDay("done")], nextDayRows: tomorrow }),
    ).notice;
    expect(clear).toMatchObject({
      kind: "all_clear",
      nextWorkingDay: "2026-09-25",
    });
  });

  it("the notice never offers a task a group already shows (N18 b)", () => {
    // All clear, but tomorrow's task T was pulled forward: it shows under Pulled forward only.
    const pulled = card({
      title: "Pulled",
      dueDate: "2026-09-25",
      taskDay: { day: "2026-09-25", status: "in_progress" },
    });
    const early = card({
      title: "Early",
      dueDate: "2026-09-25",
      taskDay: {
        day: "2026-09-25",
        status: "done",
        statusChangedOn: "2026-09-24",
      },
    });
    const window = card({
      title: "Window",
      dateKind: "window",
      plannedStart: "2026-09-21",
      dueDate: "2026-09-25",
      taskDay: null,
    });
    const other = card({
      title: "Other",
      dueDate: "2026-09-25",
      taskDay: { day: "2026-09-25" },
    });
    const clear = buildDayView(
      dayData({
        rows: [onDay("done")],
        ongoing: [window],
        pulledForward: [pulled],
        earlyDone: [early],
        nextDayRows: [
          pulled,
          early,
          { ...window, taskDay: other.taskDay },
          other,
        ],
      }),
    );
    expect(clear.notice).toMatchObject({
      kind: "all_clear",
      nextDayRows: [other],
    });
    const shown = [
      ...clear.groups.flatMap((g) => g.rows.map((r) => r.card.taskId)),
      ...(clear.notice?.kind === "all_clear"
        ? clear.notice.nextDayRows.map((c) => c.taskId)
        : []),
    ];
    expect(new Set(shown).size).toBe(shown.length);

    // Nothing planned today while a window runs: the window is under Ongoing, not offered.
    const later = card({ title: "Later", dueDate: "2026-10-07" });
    const nothing = buildDayView(
      dayData({
        ongoing: [window],
        upcoming: [{ ...window, taskDay: other.taskDay }, later],
      }),
    );
    expect(nothing.notice).toEqual({
      kind: "nothing_planned",
      upcoming: [later],
    });
    expect(titles(nothing)).toEqual([["Ongoing", ["Window"]]]);
  });

  it("an admin with trackers but no tasks of their own sees the day as usual", () => {
    expect(text({ isAdmin: true, hasTasks: false })).toBe(
      "Nothing is planned for today.",
    );
  });
});

describe("rows (12.3, 6.5)", () => {
  it("labels the due date, and the planned date when it differs", () => {
    expect(
      dueLabel(card({ dueDate: "2026-10-23", plannedStart: "2026-10-25" })),
    ).toBe("Due Fri 23 Oct · planned Sun 25 Oct");
    expect(
      dueLabel(card({ dueDate: "2026-10-23", plannedStart: "2026-10-23" })),
    ).toBe("Due Fri 23 Oct");
    expect(
      dueLabel(
        card({ dueDate: null, dateKind: "open", plannedStart: "2026-10-30" }),
      ),
    ).toBe("From Fri 30 Oct");
  });

  it("shows the spill badge from the original due date", () => {
    expect(
      spillBadge(card({ dueDate: "2026-09-30", taskDay: { spillIndex: 2 } })),
    ).toBe("Spilled 2x · from Wed 30 Sep");
    expect(spillBadge(card())).toBeNull();
  });

  it("marks a task-day finished before its own date as done early", () => {
    const early = card({
      taskDay: {
        day: "2026-10-01",
        status: "done",
        statusChangedOn: "2026-09-24",
      },
    });
    expect(doneEarlyLabel(early)).toBe("Done early, 24 Sep");
    expect(
      doneEarlyLabel(
        card({ taskDay: { status: "done", statusChangedOn: "2026-09-24" } }),
      ),
    ).toBeNull();
  });

  it("links to the exact row", () => {
    expect(sheetRowUrl(card({ rowHint: 12 }))).toBe(
      "https://docs.google.com/spreadsheets/d/file-1/edit#gid=0&range=A12",
    );
  });

  it("enables the status control only where set_task_status would accept a change", () => {
    const today = "2026-09-24";
    expect(canChange(onDay("yet_to_start"), today)).toBe(true);
    expect(canChange(onDay("done", { locked: true }), today)).toBe(false);
    // N10: yesterday's task-day waits for its close.
    expect(canChange(onDay("in_progress", { day: "2026-09-23" }), today)).toBe(
      false,
    );
    expect(canChange(card({ removed: true }), today)).toBe(false);
    expect(canChange(card({ taskDay: null, editable: false }), today)).toBe(
      false,
    );
    expect(canChange(card({ taskDay: null }), today)).toBe(true);
  });
});

describe("calendar (12.4)", () => {
  const day = (over: Partial<MonthDay>): MonthDay => ({
    day: "2026-10-05",
    isWorking: true,
    reason: null,
    total: 0,
    finished: 0,
    notDone: 0,
    open: 0,
    locked: false,
    ...over,
  });

  it("colours each day", () => {
    expect(dayColour(day({}))).toBe("blank");
    expect(dayColour(day({ total: 3, finished: 3, locked: true }))).toBe(
      "green",
    );
    expect(
      dayColour(day({ total: 3, finished: 2, notDone: 1, locked: true })),
    ).toBe("red");
    expect(dayColour(day({ total: 2, open: 1, finished: 1 }))).toBe("amber");
    expect(dayColour(day({ isWorking: false, reason: "Dussehra" }))).toBe(
      "blank",
    );
  });

  it("lays out a month Monday first", () => {
    const weeks = monthGrid("2026-10-20");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual([
      null,
      null,
      null,
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(weeks[4]).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      null,
    ]);
    expect(monthGrid("2027-02-01")).toHaveLength(4);
  });

  it("moves by month", () => {
    expect(startOfMonth("2026-10-20")).toBe("2026-10-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(addMonths("2027-01-31", -1)).toBe("2026-12-01");
  });
});

describe("banners (12.3, 10.5, D4)", () => {
  const data = (over: Partial<BannersData> = {}): BannersData => ({
    today: "2026-10-02",
    isAdmin: true,
    yesterdayNotClosed: false,
    paused: [],
    openToday: 0,
    nextWorkingDay: "2026-10-05",
    ...over,
  });
  const at = (h: number, m: number) => h * 60 + m;

  it("tells the admin, from 08:00 IST, that yesterday is not closed", () => {
    expect(buildBanners(data({ yesterdayNotClosed: true }), at(7, 59))).toEqual(
      [],
    );
    expect(
      buildBanners(data({ yesterdayNotClosed: true }), at(8, 0)),
    ).toMatchObject([{ kind: "not_closed" }]);
    expect(
      buildBanners(
        data({ yesterdayNotClosed: true, isAdmin: false }),
        at(9, 0),
      ),
    ).toEqual([]);
  });

  it("names a paused tracker with the time of its data", () => {
    const paused = {
      id: TRACKER_A,
      name: "Sapiens",
      reason: "column 'Status' not found",
      lastPull: { date: "2026-10-02", time: "10:40" },
    };
    expect(buildBanners(data({ paused: [paused] }), at(11, 0))).toEqual([
      {
        kind: "paused",
        trackerId: TRACKER_A,
        text: "Sapiens paused: column 'Status' not found. Showing data from 10:40.",
      },
    ]);
    const older = {
      ...paused,
      lastPull: { date: "2026-10-01", time: "18:05" },
    };
    expect(buildBanners(data({ paused: [older] }), at(11, 0))[0]!.text).toBe(
      "Sapiens paused: column 'Status' not found. Showing data from Thu 1 Oct, 18:05.",
    );
  });

  it("gives the evening heads-up after 17:30 IST while tasks are open", () => {
    expect(buildBanners(data({ openToday: 3 }), at(17, 29))).toEqual([]);
    expect(buildBanners(data({ openToday: 3 }), at(17, 30))).toEqual([
      {
        kind: "heads_up",
        text: "3 tasks are still open. At midnight they move to Mon 5 Oct.",
      },
    ]);
    expect(buildBanners(data({ openToday: 1 }), at(20, 0))[0]!.text).toBe(
      "1 task is still open. At midnight it moves to Mon 5 Oct.",
    );
    expect(buildBanners(data(), at(20, 0))).toEqual([]);
  });

  it("orders them: not closed, paused, heads-up", () => {
    const all = buildBanners(
      data({
        yesterdayNotClosed: true,
        openToday: 2,
        paused: [{ id: TRACKER_A, name: "A", reason: null, lastPull: null }],
      }),
      at(18, 0),
    );
    expect(all.map((b) => b.kind)).toEqual([
      "not_closed",
      "paused",
      "heads_up",
    ]);
    expect(all[1]!.text).toBe("A paused.");
  });
});

describe("plumbing", () => {
  it("reads instants in India", () => {
    expect(istDateTime("2026-09-27T05:10:00Z")).toEqual({
      date: "2026-09-27",
      time: "10:40",
    });
    expect(istDateTime("2026-09-27T20:00:00Z")).toEqual({
      date: "2026-09-28",
      time: "01:30",
    });
  });

  it("turns database error codes into plain language", () => {
    expect(messageFor({ message: "task_day_locked" })).toBe(
      "This day is closed and can't be changed.",
    );
    expect(messageFor({ message: "connection reset" })).toBe(
      "Something went wrong. Try again.",
    );
  });
});
