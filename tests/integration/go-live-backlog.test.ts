import { beforeEach, describe, expect, it } from "vitest";

import { doneEarlyLabel } from "@/lib/domain/cards";
import type { KnitStatus } from "@/lib/domain/config";
import { DayViewData } from "@/lib/domain/day-view";
import { renderKnitNote } from "@/lib/domain/note";

import {
  createTask,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";

// PRD N61, N63, 6.11 (amends N42). Go-live defaults to the next working day, so activation
// comes before go-live and the backlog review opens while go-live is still ahead. Bring to today
// creates the task-day on the first working day on or after the later of today and go-live:
// never before go-live and never on an off day, so the close never locks a miss there. Either
// way: spill index 1, origin backlog, history only cleared, the task's current status (N19 c),
// and a note-only write-back so the sheet's Knit Note is refreshed at once (N63).

const SERVICE = { kind: "service" } as const;
const ACTIVATED = "2026-09-30"; // Wed
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)
const AFTER_GO_LIVE = "2026-10-03"; // Sat, a working day (Fri 2 Oct is a holiday)

/** The close job: every day from knit_close_start() up to yesterday, in order (10.5). */
async function closeUpToYesterday(db: Db): Promise<void> {
  for (;;) {
    const [next] = await queryAs<{ day: string | null }>(
      db,
      SERVICE,
      "select next_day_to_close()::text as day",
    );
    if (!next?.day) return;
    await queryAs(db, SERVICE, "select close_day($1)", [next.day]);
    await queryAs(db, SERVICE, "select finish_day_closure($1, '{}')", [
      next.day,
    ]);
  }
}

describe("Bring to today and the go-live date (N61, 6.11)", () => {
  const db = useTestDb();
  let admin: string;
  let task: string;

  beforeEach(async () => {
    admin = await createUser(db(), { role: "admin", name: "Admin" });
    const member = await createUser(db(), { name: "Member" });
    const trackerId = await createTracker(db(), { goLiveDate: GO_LIVE });
    // A row due before go-live, still open in the sheet: history only, in the backlog review.
    task = await createTask(db(), {
      trackerId,
      assignees: [member],
      historyOnly: true,
      dueDate: "2026-09-29",
      status: "in_progress",
    });
  });

  async function bringToToday(): Promise<void> {
    const [result] = await queryAs<{ r: { changed: number } }>(
      db(),
      { kind: "user", id: admin },
      "select backlog_action($1::uuid[], 'bring_to_today') as r",
      [`{${task}}`],
    );
    expect(result?.r).toEqual({ changed: 1 });
  }

  async function historyOnly(): Promise<boolean | undefined> {
    const [row] = await db().query<{ history_only: boolean }>(
      "select history_only from tasks where id = $1",
      [task],
    );
    return row?.history_only;
  }

  const shape = async () =>
    (await taskDays(db(), task)).map((d) => [
      d.day,
      d.status,
      d.spill_index,
      d.origin,
      d.locked,
    ]);

  it("before go-live: the task-day goes on the go-live date, not today", async () => {
    await setToday(db(), ACTIVATED);
    await bringToToday();

    expect(await shape()).toEqual([
      [GO_LIVE, "in_progress", 1, "backlog", false],
    ]);
    expect(await historyOnly()).toBe(false);
  });

  it("before go-live: closing the day it was brought records no miss", async () => {
    await setToday(db(), ACTIVATED);
    await bringToToday();
    // On go-live day the close job closes every day before it, the activation day included.
    await setToday(db(), GO_LIVE);
    await closeUpToYesterday(db());

    const days = await taskDays(db(), task);
    expect(days.filter((d) => d.day < GO_LIVE)).toEqual([]);
    expect(days.filter((d) => d.status === "not_done")).toEqual([]);
    expect(await shape()).toEqual([
      [GO_LIVE, "in_progress", 1, "backlog", false],
    ]);
  });

  it("before go-live: the go-live day closes like any other day", async () => {
    await setToday(db(), ACTIVATED);
    await bringToToday();
    // The task is not done on go-live: its close locks it not_done and spills it on (6.4).
    await setToday(db(), AFTER_GO_LIVE);
    await closeUpToYesterday(db());

    expect(await shape()).toEqual([
      [GO_LIVE, "not_done", 1, "backlog", true],
      [AFTER_GO_LIVE, "in_progress", 2, "spillover", false],
    ]);
  });

  it("on the go-live date: today", async () => {
    await setToday(db(), GO_LIVE);
    await bringToToday();

    expect(await shape()).toEqual([
      [GO_LIVE, "in_progress", 1, "backlog", false],
    ]);
    expect(await historyOnly()).toBe(false);
  });

  it("after the go-live date: today", async () => {
    await setToday(db(), AFTER_GO_LIVE);
    await bringToToday();

    expect(await shape()).toEqual([
      [AFTER_GO_LIVE, "in_progress", 1, "backlog", false],
    ]);
    expect(await historyOnly()).toBe(false);
  });
});

/** A tracker going live on `goLive` with one open row due before it, as activation leaves it. */
async function backlogRow(
  db: Db,
  goLive: string,
): Promise<{ admin: string; member: string; task: string }> {
  const admin = await createUser(db, { role: "admin", name: "Admin" });
  const member = await createUser(db, { name: "Member" });
  const trackerId = await createTracker(db, { goLiveDate: goLive });
  const task = await createTask(db, {
    trackerId,
    assignees: [member],
    historyOnly: true,
    dueDate: "2026-09-29",
    status: "in_progress",
  });
  return { admin, member, task };
}

async function bring(db: Db, admin: string, task: string): Promise<void> {
  await queryAs(
    db,
    { kind: "user", id: admin },
    "select backlog_action($1::uuid[], 'bring_to_today')",
    [`{${task}}`],
  );
}

describe("Bring to today refreshes the sheet's Knit Note (N63, N17)", () => {
  const db = useTestDb();
  let admin: string;
  let task: string;

  beforeEach(async () => {
    const row = await backlogRow(db(), GO_LIVE);
    admin = row.admin;
    task = row.task;
    await setToday(db(), ACTIVATED);
  });

  const queued = async () =>
    (
      await db().query<{ note_only: boolean }>(
        `select coalesce((payload ->> 'note_only')::boolean, false) as note_only
         from outbox where task_id = $1 and state in ('pending', 'held') order by id`,
        [task],
      )
    ).map((r) => r.note_only);

  it("queues a note-only write-back in the same call", async () => {
    await bring(db(), admin, task);
    expect(await queued()).toEqual([true]);
  });

  it("queues none when a write-back is already waiting: that push writes the note too", async () => {
    await db().query(
      `insert into outbox (task_id, tracker_id, payload)
       select id, tracker_id, '{"status_value": "In progress"}'::jsonb from tasks where id = $1`,
      [task],
    );
    await bring(db(), admin, task);
    expect(await queued()).toEqual([false]);
  });

  it("queues none for a task of an archived tracker (N17: active or paused only)", async () => {
    await db().query(
      "update trackers set state = 'archived' where id = (select tracker_id from tasks where id = $1)",
      [task],
    );
    await bring(db(), admin, task);
    expect(await queued()).toEqual([]);
  });
});

describe("Bring to today never on an off day (N61)", () => {
  const db = useTestDb();
  const HOLIDAY_GO_LIVE = "2026-10-02"; // Fri, Gandhi Jayanti
  const SUNDAY = "2026-10-04";
  const MONDAY = "2026-10-05";

  const shape = async (task: string) =>
    (await taskDays(db(), task)).map((d) => [
      d.day,
      d.status,
      d.spill_index,
      d.origin,
      d.locked,
    ]);

  it("go-live ahead on an off day: the working day after it, and no miss", async () => {
    const { admin, task } = await backlogRow(db(), HOLIDAY_GO_LIVE);
    await setToday(db(), ACTIVATED);
    await bring(db(), admin, task);
    expect(await shape(task)).toEqual([
      [AFTER_GO_LIVE, "in_progress", 1, "backlog", false],
    ]);

    await setToday(db(), AFTER_GO_LIVE);
    await closeUpToYesterday(db());
    const days = await taskDays(db(), task);
    expect(days.filter((d) => d.day === HOLIDAY_GO_LIVE)).toEqual([]);
    expect(days.filter((d) => d.status === "not_done")).toEqual([]);
    expect(await shape(task)).toEqual([
      [AFTER_GO_LIVE, "in_progress", 1, "backlog", false],
    ]);
  });

  it("after go-live on an off day: the next working day", async () => {
    const { admin, task } = await backlogRow(db(), GO_LIVE);
    await setToday(db(), SUNDAY);
    await bring(db(), admin, task);
    expect(await shape(task)).toEqual([
      [MONDAY, "in_progress", 1, "backlog", false],
    ]);
  });

  it("refuses with calendar_not_covered when the calendar does not reach the day", async () => {
    const [last] = await db().query<{ day: string }>(
      "select max(day)::text as day from calendar_days",
    );
    const beyond = await db().query<{ day: string }>(
      "select ($1::date + 7)::text as day",
      [last!.day],
    );
    const { admin, task } = await backlogRow(db(), beyond[0]!.day);
    await setToday(db(), ACTIVATED);
    await expect(bring(db(), admin, task)).rejects.toThrow(
      /calendar_not_covered/,
    );

    // Nothing is applied: still history only, no task-day, nothing queued.
    const [row] = await db().query<{ history_only: boolean }>(
      "select history_only from tasks where id = $1",
      [task],
    );
    expect(row?.history_only).toBe(true);
    expect(await taskDays(db(), task)).toEqual([]);
    const outbox = await db().query("select 1 from outbox where task_id = $1", [
      task,
    ]);
    expect(outbox).toEqual([]);
  });
});

// PRD Q7 (open, section 21; N61, 6.5, 6.9, 12.3, D3, D13). Before go-live a brought task's
// task-day sits on the go-live date, in the future, though the task was due before go-live.
// Today then treats it as a future task: In progress, it shows under Pulled forward (12.3 group
// 4 is for tasks due after today); marked done, it shows in Done today tagged "early" and its
// row reads "Done early, 30 Sep" (6.5 compares with the task-day's date), while its Knit Note
// reads "Done on Wed 30 Sep · after 1 spill" (6.9 compares with the due date). One option:
// Pulled forward and Done early leave out backlog task-days, and the row's "Done early" label
// compares with the task's due date as the note does. The first tests pin today's behaviour;
// the last, an expected failure, states what any answer must give (the row and the note
// agree). When Q7 is decided, replace them.
describe("A brought task before go-live on Today (PRD Q7, open)", () => {
  const db = useTestDb();
  let member: string;
  let task: string;

  beforeEach(async () => {
    const row = await backlogRow(db(), GO_LIVE);
    member = row.member;
    task = row.task;
    await setToday(db(), ACTIVATED);
    await bring(db(), row.admin, task);
  });

  const today = async () => {
    const [row] = await queryAs<{ v: unknown }>(
      db(),
      { kind: "user", id: member },
      "select day_view(null) as v",
    );
    return DayViewData.parse(row!.v);
  };

  async function markDone(): Promise<void> {
    await queryAs(
      db(),
      { kind: "user", id: member },
      "select set_task_status($1, 'done')",
      [task],
    );
  }

  async function note(): Promise<string> {
    const [t] = await db().query<{
      status: KnitStatus;
      status_reason: string | null;
      completed_on: string | null;
      due_date: string | null;
      history_only: boolean;
    }>(
      `select status, status_reason, completed_on::text, due_date::text, history_only
       from tasks where id = $1`,
      [task],
    );
    const days = await taskDays(db(), task);
    return renderKnitNote(
      {
        status: t!.status,
        statusReason: t!.status_reason,
        completedOn: t!.completed_on,
        dueDate: t!.due_date,
        historyOnly: t!.history_only,
      },
      days.map((d) => ({
        day: d.day,
        status: d.status as KnitStatus,
        spillIndex: d.spill_index,
        locked: d.locked,
      })),
      ACTIVATED,
    );
  }

  it("Q7, until decided: In progress, it shows under Pulled forward", async () => {
    const view = await today();
    expect(view.rows).toEqual([]);
    expect(view.pulledForward.map((c) => c.taskId)).toEqual([task]);
  });

  it("Q7, until decided: done before go-live, its row reads Done early while its note reads after 1 spill", async () => {
    await markDone();
    const view = await today();
    expect(view.earlyDone.map((c) => c.taskId)).toEqual([task]);
    expect(doneEarlyLabel(view.earlyDone[0]!)).toBe("Done early, 30 Sep");
    expect(await note()).toBe("Done on Wed 30 Sep · after 1 spill");
  });

  it.fails(
    "Q7: the row and the Knit Note agree on whether it was done early",
    async () => {
      await markDone();
      const view = await today();
      const card = view.earlyDone.find((c) => c.taskId === task)!;
      expect(doneEarlyLabel(card) !== null).toBe(
        (await note()).startsWith("Done early"),
      );
    },
  );
});
