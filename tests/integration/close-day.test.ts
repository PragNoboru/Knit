import { beforeEach, describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTask,
  createTaskDay,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";

const SERVICE = { kind: "service" } as const;

interface CloseStats {
  day: string;
  next_working_day: string;
  locked_as_is: number;
  not_done: number;
  blocked: number;
  spillovers: number;
  early_completions_locked: number;
  task_ids: string[];
}

/** Closes `day` as the close job would: as the service role, on a later "today". */
async function closeDay(
  db: Db,
  day: string,
  today: string,
): Promise<CloseStats> {
  await setToday(db, today);
  const rows = await queryAs<{ stats: CloseStats }>(
    db,
    SERVICE,
    "select close_day($1) as stats",
    [day],
  );
  return rows[0]!.stats;
}

async function setStatusAs(
  db: Db,
  userId: string,
  taskId: string,
  status: string,
  today: string,
  reason?: string,
) {
  await setToday(db, today);
  await queryAs(
    db,
    { kind: "user", id: userId },
    "select set_task_status($1, $2::knit_status, $3)",
    [taskId, status, reason ?? null],
  );
}

describe("close_day (PRD 6.4, 9.1, D10)", () => {
  const db = useTestDb();
  let member: string;
  let trackerId: string;

  beforeEach(async () => {
    member = await createUser(db(), { role: "member" });
    trackerId = await createTracker(db());
  });

  it("follows the PRD 6.4 worked example (G21) to the letter", async () => {
    // G21, planned Wed 30 Sep, In progress when the day ends.
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      title: "Publish the staged pages",
      day: "2026-09-30",
    });
    await setStatusAs(db(), member, taskId, "in_progress", "2026-09-30");

    // Wed 30 Sep: locked Not Done (carried In progress), spillover Thu 1 Oct, spill 1.
    const wed = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(wed).toMatchObject({
      next_working_day: "2026-10-01",
      not_done: 1,
      spillovers: 1,
    });

    // Thu 1 Oct: not finished. Next working day skips Fri 2 Oct (Gandhi Jayanti): Sat 3 Oct
    // (1st Saturday), spill 2.
    const thu = await closeDay(db(), "2026-10-01", "2026-10-02");
    expect(thu).toMatchObject({
      next_working_day: "2026-10-03",
      not_done: 1,
      spillovers: 1,
    });

    // Fri 2 Oct is off: closing it has nothing to do.
    const fri = await closeDay(db(), "2026-10-02", "2026-10-03");
    expect(fri).toMatchObject({
      locked_as_is: 0,
      not_done: 0,
      blocked: 0,
      spillovers: 0,
    });

    // Sat 3 Oct: not finished. Sun 4 Oct is off: spillover Mon 5 Oct, spill 3.
    const sat = await closeDay(db(), "2026-10-03", "2026-10-05");
    expect(sat).toMatchObject({
      next_working_day: "2026-10-05",
      not_done: 1,
      spillovers: 1,
    });
    await closeDay(db(), "2026-10-04", "2026-10-05");

    // Mon 5 Oct: done at 19:10. The task-day is done and locks at close; nothing spills.
    await setStatusAs(db(), member, taskId, "done", "2026-10-05");
    const mon = await closeDay(db(), "2026-10-05", "2026-10-06");
    expect(mon).toMatchObject({ locked_as_is: 1, not_done: 0, spillovers: 0 });

    expect(await taskDays(db(), taskId)).toEqual([
      expect.objectContaining({
        day: "2026-09-30",
        status: "not_done",
        carried_status: "in_progress",
        spill_index: 0,
        origin: "planned",
        locked: true,
      }),
      expect.objectContaining({
        day: "2026-10-01",
        status: "not_done",
        carried_status: "in_progress",
        spill_index: 1,
        origin: "spillover",
        locked: true,
      }),
      expect.objectContaining({
        day: "2026-10-03",
        status: "not_done",
        carried_status: "in_progress",
        spill_index: 2,
        origin: "spillover",
        locked: true,
      }),
      expect.objectContaining({
        day: "2026-10-05",
        status: "done",
        carried_status: null,
        spill_index: 3,
        origin: "spillover",
        locked: true,
      }),
    ]);
  });

  it("spills Yet to Start the same way, skipping 2nd Saturdays and Sundays", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-09",
    });
    const stats = await closeDay(db(), "2026-10-09", "2026-10-10");
    expect(stats.next_working_day).toBe("2026-10-12");
    expect(await taskDays(db(), taskId)).toMatchObject([
      {
        day: "2026-10-09",
        status: "not_done",
        carried_status: "yet_to_start",
        locked: true,
      },
      {
        day: "2026-10-12",
        status: "yet_to_start",
        spill_index: 1,
        origin: "spillover",
        locked: false,
      },
    ]);
  });

  it("keeps Blocked as Blocked, carries it and its reason forward, and does not count a miss", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    await setStatusAs(
      db(),
      member,
      taskId,
      "blocked",
      "2026-09-30",
      "Waiting for GTM access",
    );
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats).toMatchObject({ blocked: 1, not_done: 0, spillovers: 1 });
    expect(await taskDays(db(), taskId)).toMatchObject([
      {
        day: "2026-09-30",
        status: "blocked",
        carried_status: "blocked",
        locked: true,
      },
      {
        day: "2026-10-01",
        status: "blocked",
        reason: "Waiting for GTM access",
        spill_index: 1,
        locked: false,
      },
    ]);
  });

  it("locks Done and Cancelled as they are, without spilling", async () => {
    const done = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    const cancelled = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    await setStatusAs(db(), member, done.taskId, "done", "2026-09-30");
    await setStatusAs(
      db(),
      member,
      cancelled.taskId,
      "cancelled",
      "2026-09-30",
      "Dropped",
    );
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats).toMatchObject({
      locked_as_is: 2,
      not_done: 0,
      spillovers: 0,
    });
    expect(await taskDays(db(), done.taskId)).toMatchObject([
      { status: "done", locked: true },
    ]);
    expect(await taskDays(db(), cancelled.taskId)).toMatchObject([
      { status: "cancelled", locked: true },
    ]);
  });

  it("is idempotent: closing a day twice changes nothing the second time", async () => {
    const a = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    const b = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    await setStatusAs(db(), member, b.taskId, "done", "2026-09-30");

    const result = await closeDay(db(), "2026-09-30", "2026-10-01");
    const snapshot = () =>
      db().query(
        `select task_id::text, day::text, status::text, carried_status::text, spill_index, origin,
                reason, locked, locked_at, status_changed_on::text
         from task_days where task_id in ($1, $2) order by task_id, day`,
        [a.taskId, b.taskId],
      );
    const counts = () =>
      db().query(
        `select (select count(*)::int from events) as events,
                (select count(*)::int from outbox) as outbox`,
      );
    const first = await snapshot();
    const firstCounts = await counts();

    // The second call changes nothing and returns what closing the day did (19).
    const second = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(second).toEqual(result);
    expect(second).toMatchObject({
      locked_as_is: 1,
      not_done: 1,
      spillovers: 1,
      // b's status write-back is still waiting, and it writes the note too (N17).
      notes_queued: 1,
      task_ids: [a.taskId, b.taskId].sort(),
    });
    expect(await snapshot()).toEqual(first);
    expect(await counts()).toEqual(firstCounts);
  });

  it("moves the state_version of the trackers it changed, once: a second call moves nothing (8.1, 9.1)", async () => {
    const quiet = await createTracker(db(), { name: "Quiet tracker" });
    await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    // Nothing of this tracker is on 30 Sep: its plans stay valid.
    await createPlannedTask(db(), {
      trackerId: quiet,
      assignees: [member],
      day: "2026-10-01",
    });
    const versions = async () =>
      Object.fromEntries(
        (
          await db().query<{ id: string; v: string }>(
            "select id::text, state_version::text as v from trackers where id in ($1, $2)",
            [trackerId, quiet],
          )
        ).map((row) => [row.id, Number(row.v)]),
      );
    const before = await versions();

    await closeDay(db(), "2026-09-30", "2026-10-01");
    const after = await versions();
    expect(after).toEqual({
      [trackerId]: before[trackerId]! + 1,
      [quiet]: before[quiet],
    });

    // Invariant 8: the second call changes nothing, so a plan made after the first still holds.
    await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(await versions()).toEqual(after);
  });

  it("writes a system event for each task-day it turns into Not Done, and none for Blocked (15)", async () => {
    const open = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    const started = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    const blocked = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    await setStatusAs(
      db(),
      member,
      started.taskId,
      "in_progress",
      "2026-09-30",
    );
    await setStatusAs(
      db(),
      member,
      blocked.taskId,
      "blocked",
      "2026-09-30",
      "Waiting",
    );
    const systemEvents = () =>
      db().query(
        `select task_id::text, task_day_id::text, tracker_id::text, actor_user_id, field,
                old_value, new_value
         from events where origin = 'system' order by old_value`,
      );

    await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(await systemEvents()).toEqual([
      {
        task_id: started.taskId,
        task_day_id: started.taskDayId,
        tracker_id: trackerId,
        actor_user_id: null,
        field: "status",
        old_value: "in_progress",
        new_value: "not_done",
      },
      {
        task_id: open.taskId,
        task_day_id: open.taskDayId,
        tracker_id: trackerId,
        actor_user_id: null,
        field: "status",
        old_value: "yet_to_start",
        new_value: "not_done",
      },
    ]);

    await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(await systemEvents()).toHaveLength(2);
  });

  it("freezes early completions: a future task-day done on D locks when D closes (6.5)", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-05",
    });
    await setStatusAs(db(), member, taskId, "done", "2026-09-30");
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats.early_completions_locked).toBe(1);
    expect(stats.task_ids).toEqual([taskId]);
    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-10-05", status: "done", locked: true },
    ]);
  });

  it("never spills a pulled-forward task before its due date (D3)", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-05",
    });
    await setStatusAs(db(), member, taskId, "in_progress", "2026-09-30");
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats).toMatchObject({ not_done: 0, spillovers: 0 });
    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-10-05", status: "in_progress", locked: false },
    ]);
  });

  it("never spills an open-ended task's completion record (N4)", async () => {
    const taskId = await createTask(db(), {
      trackerId,
      assignees: [member],
      dateKind: "open",
      plannedStart: "2026-09-28",
    });
    await setStatusAs(db(), member, taskId, "done", "2026-09-30");
    await setStatusAs(db(), member, taskId, "in_progress", "2026-09-30"); // changed back the same day
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats).toMatchObject({
      locked_as_is: 1,
      not_done: 0,
      spillovers: 0,
    });
    expect(await taskDays(db(), taskId)).toMatchObject([
      {
        day: "2026-09-30",
        status: "in_progress",
        origin: "completion",
        locked: true,
      },
    ]);
  });

  it("catches up a 3-day outage in date order, one day at a time", async () => {
    // Task-days on Wed, Thu and Sat before the close job ran again on Mon 5 Oct.
    const wed = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    const thu = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-01",
    });
    const sat = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-03",
    });
    for (const day of [
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]) {
      await closeDay(db(), day, "2026-10-05");
    }
    expect(
      (await taskDays(db(), wed.taskId)).map((d) => [
        d.day,
        d.spill_index,
        d.status,
      ]),
    ).toEqual([
      ["2026-09-30", 0, "not_done"],
      ["2026-10-01", 1, "not_done"],
      ["2026-10-03", 2, "not_done"],
      ["2026-10-05", 3, "yet_to_start"],
    ]);
    expect(
      (await taskDays(db(), thu.taskId)).map((d) => [d.day, d.spill_index]),
    ).toEqual([
      ["2026-10-01", 0],
      ["2026-10-03", 1],
      ["2026-10-05", 2],
    ]);
    expect(
      (await taskDays(db(), sat.taskId)).map((d) => [d.day, d.spill_index]),
    ).toEqual([
      ["2026-10-03", 0],
      ["2026-10-05", 1],
    ]);
  });

  it("refuses to close today or a future day", async () => {
    await expect(
      closeDay(db(), "2026-10-01", "2026-10-01"),
    ).rejects.toMatchObject({
      message: "close_day_not_past",
    });
    await expect(
      closeDay(db(), "2026-10-02", "2026-10-01"),
    ).rejects.toMatchObject({
      message: "close_day_not_past",
    });
  });

  it("refuses to close a day while an earlier day still has open task-days (6.4 step 3)", async () => {
    await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-09-30",
    });
    await expect(
      closeDay(db(), "2026-10-01", "2026-10-02"),
    ).rejects.toMatchObject({
      message: "close_day_out_of_order",
    });
  });

  it("the close job starts from a task-day earlier than every go-live, so later days can close (10.5, N12)", async () => {
    // The only tracker goes live on Thu 1 Oct. On Mon 28 Sep the admin brings a backlog row to
    // today (6.11), and an open-ended task is completed early on Tue 29 Sep for Mon 5 Oct.
    await db().query("update trackers set go_live_date = '2026-10-01'");
    const backlog = await createTask(db(), {
      trackerId,
      assignees: [member],
      dueDate: "2026-09-21",
    });
    await createTaskDay(db(), {
      taskId: backlog,
      day: "2026-09-28",
      spillIndex: 1,
      origin: "backlog",
    });
    const early = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-05",
    });
    await setStatusAs(db(), member, early.taskId, "done", "2026-09-29");

    const nextDay = async (today: string) => {
      await setToday(db(), today);
      const [row] = await queryAs<{ day: string | null }>(
        db(),
        SERVICE,
        "select next_day_to_close()::text as day",
      );
      return row!.day;
    };
    expect(await nextDay("2026-09-29")).toBe("2026-09-28");

    // On Fri 2 Oct the job closes every day from Mon 28 Sep, in order.
    const closed: string[] = [];
    for (let day = await nextDay("2026-10-02"); day;) {
      await queryAs(db(), SERVICE, "select close_day($1)", [day]);
      await queryAs(db(), SERVICE, "select finish_day_closure($1, '{}')", [
        day,
      ]);
      closed.push(day);
      day = await nextDay("2026-10-02");
    }
    expect(closed).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
    expect(
      (await taskDays(db(), backlog)).map((d) => [d.day, d.status, d.locked]),
    ).toEqual([
      ["2026-09-28", "not_done", true],
      ["2026-09-29", "not_done", true],
      ["2026-09-30", "not_done", true],
      ["2026-10-01", "not_done", true],
      ["2026-10-03", "yet_to_start", false],
    ]);
    expect(await taskDays(db(), early.taskId)).toMatchObject([
      { day: "2026-10-05", status: "done", locked: true },
    ]);
  });

  it("is refused to signed-in users, the admin included", async () => {
    const admin = await createUser(db(), { role: "admin" });
    await setToday(db(), "2026-10-01");
    await expect(
      queryAs(
        db(),
        { kind: "user", id: admin },
        "select close_day('2026-09-30')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not spill onto a day that already has the task (on conflict do nothing)", async () => {
    const taskId = await createTask(db(), {
      trackerId,
      assignees: [member],
      dueDate: "2026-09-30",
    });
    await createTaskDay(db(), { taskId, day: "2026-09-30" });
    await createTaskDay(db(), {
      taskId,
      day: "2026-10-01",
      status: "in_progress",
      spillIndex: 0,
    });
    const stats = await closeDay(db(), "2026-09-30", "2026-10-01");
    expect(stats).toMatchObject({ not_done: 1, spillovers: 0 });
    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-09-30", status: "not_done" },
      { day: "2026-10-01", status: "in_progress", spill_index: 0 },
    ]);
  });
});
