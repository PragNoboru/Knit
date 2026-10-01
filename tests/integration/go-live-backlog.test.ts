import { beforeEach, describe, expect, it } from "vitest";

import {
  createTask,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";

// PRD N61, 6.11 (amends N42). Go-live defaults to the next working day, so activation comes
// before go-live and the backlog review opens while go-live is still ahead. Bring to today then
// creates the task-day on the go-live date, never on a day before it, so the close never locks
// a miss there. From the go-live date on it uses today. Either way: spill index 1, origin
// backlog, history only cleared, the task's current status (N19 c).

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
