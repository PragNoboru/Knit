import { beforeEach, describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTask,
  createTaskDay,
  createTracker,
  createUser,
  NOBORU_CA_CAMPAIGN,
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

  describe("a correction that reopens a finished task (Q6, N15)", () => {
    /** A task planned on `day`, set done (or cancelled) there by the member. */
    async function finishedOn(
      day: string,
      status: "done" | "cancelled" = "done",
      reason: string | null = null,
      tracker = trackerId,
    ): Promise<string> {
      const id = (
        await createPlannedTask(db(), {
          trackerId: tracker,
          assignees: [member],
          day,
        })
      ).taskId;
      await setToday(db(), day);
      await queryAs(
        db(),
        as(member),
        "select set_task_status($1, $2::knit_status, $3)",
        [id, status, reason],
      );
      return id;
    }

    const taskRow = (id: string) =>
      db()
        .query(
          "select status::text, status_reason, completed_on::text from tasks where id = $1",
          [id],
        )
        .then((rows) => rows[0]);
    const corrections = (id: string) =>
      db().query(
        `select d.day::text, e.old_value, e.new_value, e.reason, e.actor_user_id::text
         from events e join task_days d on d.id = e.task_day_id
         where e.task_id = $1 and e.origin = 'correction' order by e.id`,
        [id],
      );
    const outbox = (id: string) =>
      db().query(
        "select state::text, payload from outbox where task_id = $1 order by id",
        [id],
      );
    const version = () =>
      db()
        .query<{ v: string }>(
          "select state_version::text as v from trackers where id = $1",
          [trackerId],
        )
        .then((rows) => Number(rows[0]!.v));
    /** Everything a refused correction must leave as it was. */
    const everything = (id: string) =>
      Promise.all([
        taskDays(db(), id),
        taskRow(id),
        outbox(id),
        db().query("select count(*)::int as n from events where task_id = $1", [
          id,
        ]),
      ]);

    it("reopens a finished task on today as a spillover of the day it ended", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      const before = await version();

      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      );

      expect(await taskDays(db(), other)).toMatchObject([
        { day: "2026-10-03", status: "in_progress", locked: true },
        {
          day: "2026-10-05",
          status: "in_progress",
          locked: false,
          spill_index: 1,
          origin: "spillover",
          reason: null,
          status_changed_on: "2026-10-05",
        },
      ]);
      expect(await taskRow(other)).toEqual({
        status: "in_progress",
        status_reason: null,
        completed_on: null,
      });
      expect(await corrections(other)).toEqual([
        {
          day: "2026-10-03",
          old_value: "done",
          new_value: "in_progress",
          reason: "Not really done",
          actor_user_id: admin,
        },
        {
          day: "2026-10-05",
          old_value: "done",
          new_value: "in_progress",
          reason: "Not really done",
          actor_user_id: admin,
        },
      ]);
      expect(await outbox(other)).toEqual([
        {
          state: "superseded",
          payload: { status_value: "Done", completed_on: "2026-10-03" },
        },
        {
          state: "pending",
          payload: { status_value: "In progress", completed_on: null },
        },
      ]);
      expect(await version()).toBeGreaterThan(before);
    });

    it("on a day off or a holiday, reopens on the next working day", async () => {
      const sunday = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03"], "2026-10-04");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), sunday, "2026-10-03"),
        "yet_to_start",
        "Not started after all",
      );
      expect((await taskDays(db(), sunday)).map((d) => d.day)).toEqual([
        "2026-10-03",
        "2026-10-05",
      ]);

      // Done on Thu 1 Oct; corrected on Fri 2 Oct (Gandhi Jayanti): Sat 3 Oct, a 1st Saturday.
      const holiday = (
        await createPlannedTask(db(), { trackerId, day: "2026-10-01" })
      ).taskId;
      await db().query(
        `update task_days set status = 'done', locked = true, locked_at = now()
         where task_id = $1`,
        [holiday],
      );
      await db().query(
        "update tasks set status = 'done', completed_on = '2026-10-01' where id = $1",
        [holiday],
      );
      await setToday(db(), "2026-10-02");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), holiday, "2026-10-01"),
        "in_progress",
        "Still going",
      );
      expect(await taskDays(db(), holiday)).toMatchObject([
        { day: "2026-10-01", status: "in_progress", locked: true },
        { day: "2026-10-03", status: "in_progress", locked: false },
      ]);
    });

    it("a Blocked correction carries its reason to the task, its new task-day and the write-back word", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "blocked",
        "Waiting on the agency",
      );
      expect(await taskDays(db(), other)).toMatchObject([
        { day: "2026-10-03", status: "blocked" },
        {
          day: "2026-10-05",
          status: "blocked",
          reason: "Waiting on the agency",
        },
      ]);
      expect(await taskRow(other)).toEqual({
        status: "blocked",
        status_reason: "Waiting on the agency",
        completed_on: null,
      });
      expect((await outbox(other)).at(-1)).toEqual({
        state: "pending",
        payload: { status_value: "Blocked", completed_on: null },
      });
    });

    it("the reopened task-day closes like any other", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      );
      await closeDays(db(), ["2026-10-05"], "2026-10-06");
      expect(await taskDays(db(), other)).toMatchObject([
        { day: "2026-10-03", status: "in_progress", locked: true },
        {
          day: "2026-10-05",
          status: "not_done",
          carried_status: "in_progress",
          locked: true,
        },
        {
          day: "2026-10-06",
          status: "in_progress",
          spill_index: 2,
          origin: "spillover",
          locked: false,
        },
      ]);
    });

    it("undoes a mistaken Done correction the same day: today's cancelled task-day reopens in place", async () => {
      await setToday(db(), "2026-10-03");
      const wednesday = await taskDayId(db(), taskId, "2026-09-30");
      await correct(db(), as(admin), wednesday, "done", "Done on Wednesday");
      await correct(db(), as(admin), wednesday, "in_progress", "Wrong task");

      expect(await taskDays(db(), taskId)).toMatchObject([
        { day: "2026-09-30", status: "in_progress", locked: true },
        {
          day: "2026-10-01",
          status: "cancelled",
          reason: "Closed by correction on Sat 3 Oct",
          locked: true,
        },
        {
          day: "2026-10-03",
          status: "in_progress",
          locked: false,
          spill_index: 1,
          origin: "spillover",
          reason: null,
        },
      ]);
      expect(await taskRow(taskId)).toEqual({
        status: "in_progress",
        status_reason: null,
        completed_on: null,
      });
      expect((await corrections(taskId)).slice(-2)).toEqual([
        {
          day: "2026-09-30",
          old_value: "done",
          new_value: "in_progress",
          reason: "Wrong task",
          actor_user_id: admin,
        },
        {
          day: "2026-10-03",
          old_value: "cancelled",
          new_value: "in_progress",
          reason: "Wrong task",
          actor_user_id: admin,
        },
      ]);
    });

    it("undoes a mistaken Done correction on a later day with the same spill index", async () => {
      await setToday(db(), "2026-10-03");
      const wednesday = await taskDayId(db(), taskId, "2026-09-30");
      await correct(db(), as(admin), wednesday, "done", "Done on Wednesday");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(db(), as(admin), wednesday, "in_progress", "Wrong task");

      expect(await taskDays(db(), taskId)).toMatchObject([
        { day: "2026-09-30", status: "in_progress", locked: true },
        { day: "2026-10-01", status: "cancelled", locked: true },
        { day: "2026-10-03", status: "cancelled", locked: true },
        {
          day: "2026-10-05",
          status: "in_progress",
          locked: false,
          spill_index: 1,
          origin: "spillover",
        },
      ]);
    });

    it("reopens a frozen early completion on its own day", async () => {
      const early = (
        await createPlannedTask(db(), {
          trackerId,
          assignees: [member],
          day: "2026-10-09",
        })
      ).taskId;
      // The beforeEach task is open on Sat 3 Oct, so those days close first.
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
        early,
      ]);
      await closeDays(db(), ["2026-10-05"], "2026-10-06");
      expect(await taskDays(db(), early)).toMatchObject([
        { day: "2026-10-09", status: "done", locked: true },
      ]);

      await correct(
        db(),
        as(admin),
        await taskDayId(db(), early, "2026-10-09"),
        "yet_to_start",
        "Done by mistake",
      );
      expect(await taskDays(db(), early)).toMatchObject([
        {
          day: "2026-10-09",
          status: "yet_to_start",
          locked: false,
          spill_index: 0,
          origin: "planned",
        },
      ]);
      const [day] = await db().query(
        "select locked_at from task_days where task_id = $1",
        [early],
      );
      expect(day).toEqual({ locked_at: null });
      expect(await taskRow(early)).toMatchObject({
        status: "yet_to_start",
        completed_on: null,
      });
      expect(await corrections(early)).toHaveLength(1);

      await queryAs(
        db(),
        as(member),
        "select set_task_status($1, 'in_progress')",
        [early],
      );
      expect(await taskRow(early)).toMatchObject({ status: "in_progress" });
    });

    it("still refuses a non-final correction on an earlier day of a finished task", async () => {
      await setToday(db(), "2026-10-03");
      await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
        taskId,
      ]);
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      const thursday = await taskDayId(db(), taskId, "2026-10-01");
      const before = await everything(taskId);
      await expect(
        correct(db(), as(admin), thursday, "blocked", "Was blocked"),
      ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
      expect(await everything(taskId)).toEqual(before);

      // A final status still closes the chain from there.
      await correct(db(), as(admin), thursday, "cancelled", "Not needed");
      expect(await taskDays(db(), taskId)).toMatchObject([
        { day: "2026-09-30", status: "not_done" },
        { day: "2026-10-01", status: "cancelled", reason: "Not needed" },
        {
          day: "2026-10-03",
          status: "cancelled",
          reason: "Closed by correction on Mon 5 Oct",
        },
      ]);
    });

    it("still refuses a non-final correction on a day a correction cancelled", async () => {
      await setToday(db(), "2026-10-03");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), taskId, "2026-09-30"),
        "done",
        "Done on Wednesday",
      );
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      const before = await everything(taskId);
      for (const day of ["2026-10-01", "2026-10-03"]) {
        await expect(
          correct(
            db(),
            as(admin),
            await taskDayId(db(), taskId, day),
            "in_progress",
            "Reopen",
          ),
        ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
      }
      expect(await everything(taskId)).toEqual(before);
    });

    it("refuses a non-final correction the same day, before the cancelled days close (N15)", async () => {
      // Sat 3 Oct is cancelled by the correction but still unlocked: it is not an open day.
      await setToday(db(), "2026-10-03");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), taskId, "2026-09-30"),
        "done",
        "Done on Wednesday",
      );
      const before = await everything(taskId);
      await expect(
        correct(
          db(),
          as(admin),
          await taskDayId(db(), taskId, "2026-10-01"),
          "in_progress",
          "Reopen",
        ),
      ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
      expect(await everything(taskId)).toEqual(before);
    });

    it("refuses a non-final correction on an earlier day of a task finished today (N15)", async () => {
      await setToday(db(), "2026-10-03");
      await queryAs(db(), as(member), "select set_task_status($1, 'done')", [
        taskId,
      ]);
      const before = await everything(taskId);
      await expect(
        correct(
          db(),
          as(admin),
          await taskDayId(db(), taskId, "2026-10-01"),
          "blocked",
          "Was blocked",
        ),
      ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
      expect(await everything(taskId)).toEqual(before);
    });

    it("a member's Cancelled reason in a correction's words on a later day still marks the day the task ended", async () => {
      await setToday(db(), "2026-10-03");
      await queryAs(
        db(),
        as(member),
        "select set_task_status($1, 'cancelled', $2)",
        [taskId, "Closed by correction on Sat 3 Oct"],
      );
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      const before = await everything(taskId);
      // Sat 3 Oct is the day the task ended, so Thu 1 Oct is an earlier day.
      await expect(
        correct(
          db(),
          as(admin),
          await taskDayId(db(), taskId, "2026-10-01"),
          "in_progress",
          "Still needed",
        ),
      ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
      expect(await everything(taskId)).toEqual(before);
    });

    it("a later day a correction cancelled and its close froze reopens in place, after the corrected day", async () => {
      // Missed on Thu 1 Oct, then planned again for Fri 9 Oct.
      const moved = await createTask(db(), {
        trackerId,
        assignees: [member],
        dueDate: "2026-10-09",
      });
      await createTaskDay(db(), {
        taskId: moved,
        day: "2026-10-01",
        status: "not_done",
        locked: true,
      });
      await createTaskDay(db(), { taskId: moved, day: "2026-10-09" });
      const thursday = await taskDayId(db(), moved, "2026-10-01");

      await setToday(db(), "2026-10-03");
      await correct(db(), as(admin), thursday, "done", "Done on Thursday");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      expect(await taskDays(db(), moved)).toMatchObject([
        { day: "2026-10-01", status: "done", locked: true },
        {
          day: "2026-10-09",
          status: "cancelled",
          reason: "Closed by correction on Sat 3 Oct",
          locked: true,
        },
      ]);

      await correct(db(), as(admin), thursday, "in_progress", "Wrong task");
      expect(await taskDays(db(), moved)).toMatchObject([
        { day: "2026-10-01", status: "in_progress", locked: true },
        {
          day: "2026-10-09",
          status: "in_progress",
          reason: null,
          locked: false,
          spill_index: 1,
          origin: "planned",
          status_changed_on: "2026-10-05",
        },
      ]);
      const [friday] = await db().query(
        "select locked_at from task_days where task_id = $1 and day = '2026-10-09'",
        [moved],
      );
      expect(friday).toEqual({ locked_at: null });
      expect(await taskRow(moved)).toEqual({
        status: "in_progress",
        status_reason: null,
        completed_on: null,
      });
      expect((await corrections(moved)).slice(-2)).toEqual([
        {
          day: "2026-10-01",
          old_value: "done",
          new_value: "in_progress",
          reason: "Wrong task",
          actor_user_id: admin,
        },
        {
          day: "2026-10-09",
          old_value: "cancelled",
          new_value: "in_progress",
          reason: "Wrong task",
          actor_user_id: admin,
        },
      ]);
    });

    it("a member's own Cancelled reason in the same words does not hide the day the task ended", async () => {
      await setToday(db(), "2026-10-03");
      await queryAs(
        db(),
        as(member),
        "select set_task_status($1, 'cancelled', $2)",
        [taskId, "Closed by correction on Sat 3 Oct"],
      );
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), taskId, "2026-10-03"),
        "in_progress",
        "Still needed",
      );
      expect((await taskDays(db(), taskId)).at(-1)).toMatchObject({
        day: "2026-10-05",
        status: "in_progress",
        spill_index: 3,
        locked: false,
      });
    });

    it("reopens a cancelled task the same way, clearing Completed On in the write-back", async () => {
      const other = await finishedOn("2026-10-03", "cancelled", "Not needed");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Needed after all",
      );
      expect(await taskRow(other)).toEqual({
        status: "in_progress",
        status_reason: null,
        completed_on: null,
      });
      expect((await corrections(other)).at(-1)).toMatchObject({
        day: "2026-10-05",
        old_value: "cancelled",
        new_value: "in_progress",
      });
      expect((await outbox(other)).at(-1)).toEqual({
        state: "pending",
        payload: { status_value: "In progress", completed_on: null },
      });
    });

    it("refuses to reopen a task removed at source", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await db().query(
        "update tasks set removed_at_source = now() where id = $1",
        [other],
      );
      const before = await everything(other);
      await expect(
        correct(
          db(),
          as(admin),
          await taskDayId(db(), other, "2026-10-03"),
          "in_progress",
          "Not really done",
        ),
      ).rejects.toMatchObject({ message: "task_removed_at_source" });
      expect(await everything(other)).toEqual(before);
    });

    it("still refuses a dated task that is open with no open task-day", async () => {
      const stuck = await createTask(db(), {
        trackerId,
        dueDate: "2026-10-01",
      });
      const day = await createTaskDay(db(), {
        taskId: stuck,
        day: "2026-10-01",
        status: "not_done",
        locked: true,
      });
      await setToday(db(), "2026-10-03");
      await expect(
        correct(db(), as(admin), day, "in_progress", "Was in progress"),
      ).rejects.toMatchObject({ message: "correction_would_orphan_task" });
    });

    it("refuses when the calendar does not cover the day it would reopen on", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03"], "2026-10-04");
      await db().query("delete from calendar_days where day > '2026-10-04'");
      const before = await everything(other);
      await expect(
        correct(
          db(),
          as(admin),
          await taskDayId(db(), other, "2026-10-03"),
          "in_progress",
          "Not really done",
        ),
      ).rejects.toMatchObject({ message: "calendar_not_covered" });
      expect(await everything(other)).toEqual(before);
    });

    it("a second identical correction only adds to the history", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      const saturday = await taskDayId(db(), other, "2026-10-03");
      await correct(db(), as(admin), saturday, "in_progress", "Not done");
      const days = await taskDays(db(), other);
      const queued = await outbox(other);
      await correct(db(), as(admin), saturday, "in_progress", "Not done");
      expect(await taskDays(db(), other)).toEqual(days);
      expect(await outbox(other)).toEqual(queued);
      expect(await corrections(other)).toHaveLength(3);
    });

    it("between midnight and the previous day's close, reopens on today and the close leaves it alone", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-06");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      );
      await queryAs(db(), SERVICE, "select close_day('2026-10-05')");
      expect(await taskDays(db(), other)).toMatchObject([
        { day: "2026-10-03", locked: true },
        { day: "2026-10-06", status: "in_progress", locked: false },
      ]);
    });

    it("a new holiday moves the reopened task-day; the pending write-back stays the only one (N37, N53)", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03"], "2026-10-04");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      );
      const queued = await outbox(other);
      await queryAs(
        db(),
        as(admin),
        "insert into holidays (day, name) values ('2026-10-05', 'Office closed')",
      );
      expect((await taskDays(db(), other)).map((d) => d.day)).toEqual([
        "2026-10-03",
        "2026-10-06",
      ]);
      expect(
        await db().query(
          `select origin::text, old_value, new_value, reason from events
           where task_id = $1 and field = 'due_date'`,
          [other],
        ),
      ).toEqual([
        {
          origin: "system",
          old_value: "2026-10-05",
          new_value: "2026-10-06",
          reason: "Office closed",
        },
      ]);
      expect(await outbox(other)).toEqual(queued);
    });

    it("resolves the item raised when the sheet reopened the task (10.3)", async () => {
      const other = await finishedOn("2026-10-03");
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await db().query(
        `insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail)
         values ($1, $2::uuid, 'conflict', 'conflict:' || $2::text, $3::jsonb),
                ($1, $2::uuid, 'bad_date', 'bad_date:' || $2::text, '{"reason": "day_already_closed"}')`,
        [
          trackerId,
          other,
          JSON.stringify({
            reason: "reopened_in_source",
            knit: "done",
            source: "in_progress",
            sourceWord: "In progress",
          }),
        ],
      );
      const items = () =>
        db().query(
          "select kind, state, resolved_at is not null as resolved from attention_items where task_id = $1 order by id",
          [other],
        );
      const saturday = await taskDayId(db(), other, "2026-10-03");

      await correct(db(), as(admin), saturday, "done", "Confirmed done");
      expect(await items()).toEqual([
        { kind: "conflict", state: "open", resolved: false },
        { kind: "bad_date", state: "open", resolved: false },
      ]);

      await correct(db(), as(admin), saturday, "in_progress", "Sheet is right");
      expect(await items()).toEqual([
        { kind: "conflict", state: "resolved", resolved: true },
        { kind: "bad_date", state: "open", resolved: false },
      ]);
    });

    it("leaves the status cell alone for a status the tracker cannot write (N8)", async () => {
      const noboru = await createTracker(db(), { fixture: NOBORU_CA_CAMPAIGN });
      const other = await finishedOn("2026-10-03", "done", null, noboru);
      await closeDays(db(), ["2026-10-03", "2026-10-04"], "2026-10-05");
      await correct(
        db(),
        as(admin),
        await taskDayId(db(), other, "2026-10-03"),
        "in_progress",
        "Not really done",
      );
      expect((await outbox(other)).at(-1)).toEqual({
        state: "pending",
        payload: { status_value: null, completed_on: null },
      });
    });
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
