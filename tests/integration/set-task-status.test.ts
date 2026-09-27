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
  act,
  queryAs,
  setToday,
  useTestDb,
  type Actor,
  type Db,
} from "./support/db";

const TODAY = "2026-09-30";

function setStatus(
  db: Db,
  actor: Actor,
  taskId: string,
  status: string,
  reason?: string,
) {
  return queryAs<{
    result: {
      task: Record<string, unknown>;
      task_day: Record<string, unknown> | null;
    };
  }>(db, actor, "select set_task_status($1, $2::knit_status, $3) as result", [
    taskId,
    status,
    reason ?? null,
  ]).then((rows) => rows[0]!.result);
}

describe("set_task_status (PRD 9.1, 6.1, 6.5, D2, D3)", () => {
  const db = useTestDb();
  let member: string;
  let other: string;
  let admin: string;
  let trackerId: string;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    member = await createUser(db(), { role: "member" });
    other = await createUser(db(), { role: "member" });
    admin = await createUser(db(), { role: "admin" });
    trackerId = await createTracker(db());
  });

  const as = (id: string): Actor => ({ kind: "user", id });

  describe("who may call it", () => {
    it("lets the assigned user change today's task-day", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      const result = await setStatus(db(), as(member), taskId, "in_progress");
      expect(result.task.status).toBe("in_progress");
      expect(result.task_day?.status).toBe("in_progress");
    });

    it("refuses a user the task is not assigned to", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await expect(
        setStatus(db(), as(other), taskId, "done"),
      ).rejects.toMatchObject({
        message: "not_allowed",
        code: "42501",
      });
    });

    it("lets the admin change any task", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      const result = await setStatus(db(), as(admin), taskId, "done");
      expect(result.task.status).toBe("done");
    });

    it("refuses a deactivated user", async () => {
      const inactive = await createUser(db(), {
        role: "member",
        active: false,
      });
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [inactive],
        day: TODAY,
      });
      await expect(
        setStatus(db(), as(inactive), taskId, "done"),
      ).rejects.toMatchObject({
        message: "not_allowed",
      });
    });

    it("refuses anonymous and service-role callers", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await expect(
        setStatus(db(), { kind: "anon" }, taskId, "done"),
      ).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        setStatus(db(), { kind: "service" }, taskId, "done"),
      ).rejects.toMatchObject({
        message: "not_allowed",
      });
    });
  });

  describe("status and reason rules", () => {
    it("refuses Not Done, which only day close sets", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await expect(
        setStatus(db(), as(member), taskId, "not_done"),
      ).rejects.toMatchObject({
        message: "status_not_selectable",
      });
    });

    it.each(["blocked", "cancelled"])(
      "requires a reason for %s (D2)",
      async (status) => {
        const { taskId } = await createPlannedTask(db(), {
          trackerId,
          assignees: [member],
          day: TODAY,
        });
        await expect(
          setStatus(db(), as(member), taskId, status),
        ).rejects.toMatchObject({
          message: "reason_required",
        });
        await expect(
          setStatus(db(), as(member), taskId, status, "   "),
        ).rejects.toMatchObject({
          message: "reason_required",
        });
      },
    );

    it("limits the reason to 140 characters and trims it", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await expect(
        setStatus(db(), as(member), taskId, "blocked", "x".repeat(141)),
      ).rejects.toMatchObject({ message: "reason_too_long" });
      const result = await setStatus(
        db(),
        as(member),
        taskId,
        "blocked",
        `  ${"y".repeat(140)}  `,
      );
      expect(result.task_day?.reason).toBe("y".repeat(140));
      expect(result.task.status_reason).toBe("y".repeat(140));
    });

    it("drops the reason for statuses that do not take one", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      const result = await setStatus(
        db(),
        as(member),
        taskId,
        "in_progress",
        "ignored",
      );
      expect(result.task_day?.reason).toBeNull();
    });
  });

  describe("which task-day it changes", () => {
    it("records the change: task, task-day, event, state version, write-back", async () => {
      const { taskId, taskDayId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await setStatus(db(), as(member), taskId, "done");

      const [task] = await db().query(
        "select status::text, completed_on::text, hub_changed_at is not null as hub_changed from tasks where id = $1",
        [taskId],
      );
      expect(task).toEqual({
        status: "done",
        completed_on: TODAY,
        hub_changed: true,
      });

      const [day] = await taskDays(db(), taskId);
      expect(day).toMatchObject({
        day: TODAY,
        status: "done",
        status_changed_on: TODAY,
        locked: false,
      });

      const events = await db().query(
        `select task_day_id::text, actor_user_id::text, origin::text, field, old_value, new_value
         from events where task_id = $1`,
        [taskId],
      );
      expect(events).toEqual([
        {
          task_day_id: taskDayId,
          actor_user_id: member,
          origin: "hub",
          field: "status",
          old_value: "yet_to_start",
          new_value: "done",
        },
      ]);

      const [tracker] = await db().query(
        "select state_version::int as v from trackers where id = $1",
        [trackerId],
      );
      expect(tracker).toEqual({ v: 1 });

      const outbox = await db().query(
        "select state::text, payload from outbox where task_id = $1",
        [taskId],
      );
      expect(outbox).toEqual([
        {
          state: "pending",
          payload: { status_value: "Done", completed_on: TODAY },
        },
      ]);
    });

    it("supersedes older pending write-backs so only the newest reaches the sheet (10.4)", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await setStatus(db(), as(member), taskId, "in_progress");
      await setStatus(db(), as(member), taskId, "done");
      await setStatus(db(), as(member), taskId, "in_progress");
      const outbox = await db().query(
        "select state::text, payload from outbox where task_id = $1 order by id",
        [taskId],
      );
      expect(outbox).toEqual([
        {
          state: "superseded",
          payload: { status_value: "In progress", completed_on: null },
        },
        {
          state: "superseded",
          payload: { status_value: "Done", completed_on: TODAY },
        },
        {
          state: "pending",
          payload: { status_value: "In progress", completed_on: null },
        },
      ]);
      const [task] = await db().query(
        "select completed_on from tasks where id = $1",
        [taskId],
      );
      expect(task).toEqual({ completed_on: null });
    });

    it("queues a null status value when the tracker cannot express the status (N8)", async () => {
      const noboru = await createTracker(db(), { fixture: NOBORU_CA_CAMPAIGN });
      const { taskId } = await createPlannedTask(db(), {
        trackerId: noboru,
        assignees: [member],
        day: TODAY,
      });
      await setStatus(db(), as(member), taskId, "in_progress");
      await setStatus(db(), as(member), taskId, "done");
      const outbox = await db().query(
        "select payload from outbox where task_id = $1 order by id",
        [taskId],
      );
      expect(outbox.map((row) => row.payload)).toEqual([
        { status_value: null, completed_on: null },
        { status_value: "Yes", completed_on: TODAY },
      ]);
    });

    it("changes nothing when the status and reason are unchanged", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
      });
      await setStatus(db(), as(member), taskId, "blocked", "Waiting for T3");
      await setStatus(db(), as(member), taskId, "blocked", "Waiting for T3");
      const [counts] = await db().query(
        `select (select count(*)::int from events where task_id = $1) as events,
                (select count(*)::int from outbox where task_id = $1) as outbox`,
        [taskId],
      );
      expect(counts).toEqual({ events: 1, outbox: 1 });
    });

    it("changes a future task-day when there is none today (pulled forward, D3)", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-10-05",
      });
      const result = await setStatus(db(), as(member), taskId, "in_progress");
      expect(result.task_day).toMatchObject({
        day: "2026-10-05",
        status: "in_progress",
      });
      expect(result.task_day?.status_changed_on).toBe(TODAY);
    });

    it("records Done early with Completed On today and the planned date kept (6.5, D13)", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-10-05",
      });
      await setStatus(db(), as(member), taskId, "done");
      const [task] = await db().query(
        "select completed_on::text, due_date::text from tasks where id = $1",
        [taskId],
      );
      expect(task).toEqual({ completed_on: TODAY, due_date: "2026-10-05" });
      expect(await taskDays(db(), taskId)).toMatchObject([
        { day: "2026-10-05", status: "done", status_changed_on: TODAY },
      ]);
    });

    it("refuses a locked task-day (invariant 4)", async () => {
      const taskId = await createTask(db(), {
        trackerId,
        assignees: [member],
        dueDate: "2026-10-05",
      });
      await createTaskDay(db(), {
        taskId,
        day: "2026-10-05",
        status: "done",
        locked: true,
        statusChangedOn: "2026-09-29",
      });
      await expect(
        setStatus(db(), as(member), taskId, "in_progress"),
      ).rejects.toMatchObject({
        message: "task_day_locked",
      });
    });

    it("says the day is still closing when yesterday's task-day is not locked yet", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-09-29",
      });
      await expect(
        setStatus(db(), as(member), taskId, "done"),
      ).rejects.toMatchObject({
        message: "day_not_closed",
      });
    });

    it("refuses a task with no open task-day", async () => {
      const taskId = await createTask(db(), {
        trackerId,
        assignees: [member],
        dueDate: "2026-09-14",
        historyOnly: true,
      });
      await expect(
        setStatus(db(), as(member), taskId, "done"),
      ).rejects.toMatchObject({
        message: "no_open_task_day",
      });
    });

    it("refuses a task whose row was removed from the sheet", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: TODAY,
        removedAtSource: true,
      });
      await expect(
        setStatus(db(), as(member), taskId, "done"),
      ).rejects.toMatchObject({
        message: "task_removed_at_source",
      });
    });

    it("refuses an unknown task", async () => {
      await expect(
        setStatus(
          db(),
          as(admin),
          "00000000-0000-0000-0000-000000000000",
          "done",
        ),
      ).rejects.toMatchObject({ message: "task_not_found" });
    });
  });

  describe("open-ended tasks (N4, 6.5)", () => {
    it("creates a completion task-day on today when completed", async () => {
      const taskId = await createTask(db(), {
        trackerId,
        assignees: [member],
        dateKind: "open",
        plannedStart: "2026-09-28",
      });
      const result = await setStatus(db(), as(member), taskId, "done");
      expect(result.task_day).toMatchObject({
        day: TODAY,
        status: "done",
        origin: "completion",
      });
      expect(result.task.completed_on).toBe(TODAY);
    });

    it("keeps other statuses on the task alone, so it can never spill", async () => {
      const taskId = await createTask(db(), {
        trackerId,
        assignees: [member],
        dateKind: "open",
        plannedStart: "2026-09-28",
      });
      const result = await setStatus(db(), as(member), taskId, "in_progress");
      expect(result.task_day).toBeNull();
      expect(result.task.status).toBe("in_progress");
      expect(await taskDays(db(), taskId)).toEqual([]);
      const outbox = await db().query(
        "select count(*)::int as n from outbox where task_id = $1",
        [taskId],
      );
      expect(outbox).toEqual([{ n: 1 }]);
    });

    it("refuses to reopen a finished task once its completion day has closed (6.5, N15)", async () => {
      const done = await createTask(db(), {
        trackerId,
        assignees: [member],
        dateKind: "open",
        plannedStart: "2026-09-28",
      });
      const cancelled = await createTask(db(), {
        trackerId,
        assignees: [member],
        dateKind: "open",
        plannedStart: "2026-09-28",
      });
      await setStatus(db(), as(member), done, "done");
      await setStatus(db(), as(member), cancelled, "cancelled", "Not needed");
      // The next day, after Wed 30 Sep has closed.
      await setToday(db(), "2026-10-01");
      await queryAs(db(), { kind: "service" }, "select close_day($1)", [TODAY]);
      const writeBacks = () =>
        db().query(
          "select count(*)::int as n from outbox where task_id in ($1, $2) and not (payload ? 'note_only')",
          [done, cancelled],
        );
      const before = await writeBacks();

      await expect(
        setStatus(db(), as(member), done, "in_progress"),
      ).rejects.toMatchObject({ message: "task_day_locked" });
      await expect(
        setStatus(db(), as(member), cancelled, "done"),
      ).rejects.toMatchObject({ message: "task_day_locked" });
      expect(await writeBacks()).toEqual(before);
      expect(await taskDays(db(), cancelled)).toHaveLength(1);
      // Setting the status it already has still changes nothing (9.1).
      await expect(
        setStatus(db(), as(member), done, "done"),
      ).resolves.toMatchObject({ task: { status: "done" } });
    });
  });

  describe("early completions wait for their day's close (6.4, 6.5, N10)", () => {
    it("refuses to change a task-day done early yesterday until yesterday closes, then freezes it", async () => {
      const { taskId } = await createPlannedTask(db(), {
        trackerId,
        assignees: [member],
        day: "2026-10-05",
      });
      await setStatus(db(), as(member), taskId, "done"); // Wed 30 Sep, early

      // Thu 1 Oct, 00:05: the close of Wed 30 Sep has not run yet.
      await setToday(db(), "2026-10-01");
      await expect(
        setStatus(db(), as(member), taskId, "in_progress"),
      ).rejects.toMatchObject({ message: "day_not_closed" });

      const [stats] = await queryAs<{ stats: Record<string, unknown> }>(
        db(),
        { kind: "service" },
        "select close_day($1) as stats",
        [TODAY],
      );
      expect(stats!.stats).toMatchObject({ early_completions_locked: 1 });
      expect(await taskDays(db(), taskId)).toMatchObject([
        {
          day: "2026-10-05",
          status: "done",
          status_changed_on: TODAY,
          locked: true,
        },
      ]);
    });
  });

  it("is atomic: a refused call leaves no trace", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: TODAY,
    });
    await expect(
      setStatus(db(), as(member), taskId, "cancelled"),
    ).rejects.toBeDefined();
    const [counts] = await act(db(), { kind: "user", id: admin }, () =>
      db().query(
        `select (select count(*)::int from events where task_id = $1) as events,
                (select count(*)::int from outbox where task_id = $1) as outbox`,
        [taskId],
      ),
    );
    expect(counts).toEqual({ events: 0, outbox: 0 });
  });
});
