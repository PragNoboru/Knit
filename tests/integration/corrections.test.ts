import { beforeEach, describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTask,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import {
  queryAs,
  setToday,
  useTestDb,
  type Actor,
  type Db,
} from "./support/db";

const SERVICE = { kind: "service" } as const;

async function closeDays(db: Db, days: string[], today: string) {
  await setToday(db, today);
  for (const day of days)
    await queryAs(db, SERVICE, "select close_day($1)", [day]);
}

function correct(
  db: Db,
  actor: Actor,
  taskDayId: string,
  status: string,
  reason: string | null,
) {
  return queryAs(
    db,
    actor,
    "select admin_correct_task_day($1::bigint, $2::knit_status, $3) as result",
    [taskDayId, status, reason],
  );
}

function taskDayId(db: Db, taskId: string, day: string): Promise<string> {
  return db
    .query<{ id: string }>(
      "select id::text from task_days where task_id = $1 and day = $2",
      [taskId, day],
    )
    .then((rows) => rows[0]!.id);
}

describe("admin_correct_task_day (PRD 6.10)", () => {
  const db = useTestDb();
  let member: string;
  let admin: string;
  let trackerId: string;
  let taskId: string;

  const as = (id: string): Actor => ({ kind: "user", id });

  // A task missed on Wed 30 Sep and Thu 1 Oct, now open on Sat 3 Oct (spill 2).
  beforeEach(async () => {
    member = await createUser(db(), { role: "member" });
    admin = await createUser(db(), { role: "admin" });
    trackerId = await createTracker(db());
    taskId = (
      await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-09-30",
      })
    ).taskId;
    await closeDays(
      db(),
      ["2026-09-30", "2026-10-01", "2026-10-02"],
      "2026-10-03",
    );
  });

  it("closes the chain when a locked Not Done is corrected to Done", async () => {
    await setToday(db(), "2026-10-03");
    const wednesday = await taskDayId(db(), taskId, "2026-09-30");
    await correct(
      db(),
      as(admin),
      wednesday,
      "done",
      "Was done on Wednesday, confirmed by Anjan",
    );

    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-09-30", status: "done", locked: true },
      {
        day: "2026-10-01",
        status: "cancelled",
        reason: "Closed by correction on Sat 3 Oct",
        locked: true,
      },
      {
        day: "2026-10-03",
        status: "cancelled",
        reason: "Closed by correction on Sat 3 Oct",
        locked: false,
      },
    ]);

    const [task] = await db().query(
      "select status::text, completed_on::text from tasks where id = $1",
      [taskId],
    );
    expect(task).toEqual({ status: "done", completed_on: "2026-09-30" });

    const events = await db().query(
      `select origin::text, old_value, new_value, reason, actor_user_id::text
       from events where task_id = $1 order by id`,
      [taskId],
    );
    expect(events).toEqual([
      // The closes of Wed 30 Sep and Thu 1 Oct (PRD 15).
      {
        origin: "system",
        old_value: "yet_to_start",
        new_value: "not_done",
        reason: null,
        actor_user_id: null,
      },
      {
        origin: "system",
        old_value: "yet_to_start",
        new_value: "not_done",
        reason: null,
        actor_user_id: null,
      },
      {
        origin: "correction",
        old_value: "not_done",
        new_value: "done",
        reason: "Was done on Wednesday, confirmed by Anjan",
        actor_user_id: admin,
      },
      {
        origin: "correction",
        old_value: "not_done",
        new_value: "cancelled",
        reason: "Closed by correction on Sat 3 Oct",
        actor_user_id: admin,
      },
      {
        origin: "correction",
        old_value: "yet_to_start",
        new_value: "cancelled",
        reason: "Closed by correction on Sat 3 Oct",
        actor_user_id: admin,
      },
    ]);

    const outbox = await db().query(
      "select state::text, payload from outbox where task_id = $1 order by id",
      [taskId],
    );
    expect(outbox).toEqual([
      // The close's Knit Note refresh (N17), replaced by the correction's write-back.
      { state: "superseded", payload: { note_only: true } },
      {
        state: "pending",
        payload: { status_value: "Done", completed_on: "2026-09-30" },
      },
    ]);
  });

  it("the open task-day it cancelled locks as cancelled when today closes", async () => {
    await setToday(db(), "2026-10-03");
    await correct(
      db(),
      as(admin),
      await taskDayId(db(), taskId, "2026-09-30"),
      "cancelled",
      "Not needed any more",
    );
    await closeDays(db(), ["2026-10-03"], "2026-10-05");
    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-09-30", status: "cancelled", reason: "Not needed any more" },
      { day: "2026-10-01", status: "cancelled" },
      { day: "2026-10-03", status: "cancelled", locked: true },
    ]);
  });

  it("only rewrites history when corrected to a non-final status while the chain continues", async () => {
    await setToday(db(), "2026-10-03");
    await correct(
      db(),
      as(admin),
      await taskDayId(db(), taskId, "2026-10-01"),
      "blocked",
      "Was waiting on the agency",
    );
    expect(await taskDays(db(), taskId)).toMatchObject([
      { day: "2026-09-30", status: "not_done" },
      {
        day: "2026-10-01",
        status: "blocked",
        reason: "Was waiting on the agency",
      },
      { day: "2026-10-03", status: "yet_to_start", locked: false },
    ]);
    // No write-back; only the closes' Knit Note refresh waits (N17).
    expect(
      await db().query(
        "select count(*)::int as n from outbox where task_id = $1 and not (payload ? 'note_only')",
        [taskId],
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a correction that would leave the task with no open task-day", async () => {
    const other = (
      await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-10-03",
      })
    ).taskId;
    await setToday(db(), "2026-10-03");
    await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
      other,
    ]);
    await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
      taskId,
    ]);
    await closeDays(db(), ["2026-10-03"], "2026-10-05");
    await expect(
      correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      ),
    ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
  });

  it("reopens an open-ended task corrected back to In progress", async () => {
    const open = await createTask(db(), {
      trackerId,
      assignees: [member],
      dateKind: "open",
      plannedStart: "2026-09-28",
    });
    await setToday(db(), "2026-10-03");
    await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
      open,
    ]);
    await closeDays(db(), ["2026-10-03"], "2026-10-05");
    await correct(
      db(),
      as(admin),
      await taskDayId(db(), open, "2026-10-03"),
      "in_progress",
      "Still running",
    );
    const [task] = await db().query(
      "select status::text, completed_on from tasks where id = $1",
      [open],
    );
    expect(task).toEqual({ status: "in_progress", completed_on: null });
  });

  it("is admin only", async () => {
    await setToday(db(), "2026-10-03");
    await expect(
      correct(
        db(),
        as(member),
        await taskDayId(db(), taskId, "2026-09-30"),
        "done",
        "Trust me",
      ),
    ).rejects.toMatchObject({ message: "not_allowed", code: "42501" });
  });

  it("needs a locked task-day, a reason and a user status", async () => {
    await setToday(db(), "2026-10-03");
    const open = await taskDayId(db(), taskId, "2026-10-03");
    const locked = await taskDayId(db(), taskId, "2026-09-30");
    await expect(
      correct(db(), as(admin), open, "done", "Reason"),
    ).rejects.toMatchObject({
      message: "task_day_not_locked",
    });
    await expect(
      correct(db(), as(admin), locked, "done", " "),
    ).rejects.toMatchObject({
      message: "reason_required",
    });
    await expect(
      correct(db(), as(admin), locked, "not_done", "Reason"),
    ).rejects.toMatchObject({
      message: "status_not_selectable",
    });
    await expect(
      correct(db(), as(admin), "999999999", "done", "Reason"),
    ).rejects.toMatchObject({
      message: "task_day_not_found",
    });
  });
});
