import { beforeEach, describe, expect, it } from "vitest";

import { DayViewData } from "@/lib/domain/day-view";
import { MonthData } from "@/lib/domain/month-view";

import {
  createPlannedTask,
  createTask,
  createTaskDay,
  createTracker,
  createUser,
} from "./support/builders";
import { queryAs, setToday, useTestDb } from "./support/db";

// PRD 12, 13 (M7): the functions behind the screens, and who sees what through them.

const TODAY = "2026-09-28"; // Mon

describe("screen functions", () => {
  const db = useTestDb();
  let me: string;
  let other: string;
  let admin: string;
  let trackerId: string;
  let ids: Record<string, string>;

  const as = (user: string) => ({ kind: "user" as const, id: user });
  const call = async <T = unknown>(
    user: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const [row] = await queryAs<{ v: T }>(db(), as(user), sql, params);
    return row!.v;
  };

  beforeEach(async () => {
    me = await createUser(db(), { name: "Me" });
    other = await createUser(db(), { name: "Other" });
    admin = await createUser(db(), { role: "admin", name: "Admin" });
    trackerId = await createTracker(db(), { name: "Filing Buddy" });
    await setToday(db(), TODAY);
    const mine = { trackerId, assignees: [me] };
    const due = await createPlannedTask(db(), {
      ...mine,
      title: "Due today",
      day: TODAY,
    });
    const spilled = await createTask(db(), {
      ...mine,
      title: "Spilled",
      dueDate: "2026-09-24",
    });
    await createTaskDay(db(), {
      taskId: spilled,
      day: "2026-09-24",
      status: "not_done",
      locked: true,
    });
    await createTaskDay(db(), {
      taskId: spilled,
      day: TODAY,
      spillIndex: 1,
      origin: "spillover",
    });
    const window = await createTask(db(), {
      ...mine,
      title: "Window",
      dateKind: "window",
      plannedStart: "2026-09-21",
      dueDate: "2026-09-30",
    });
    await createTaskDay(db(), { taskId: window, day: "2026-09-30" });
    const pulled = await createPlannedTask(db(), {
      ...mine,
      title: "Pulled",
      day: "2026-10-05",
      status: "in_progress",
    });
    const early = await createTask(db(), {
      ...mine,
      title: "Early",
      dueDate: "2026-10-06",
      status: "done",
    });
    await createTaskDay(db(), {
      taskId: early,
      day: "2026-10-06",
      status: "done",
      statusChangedOn: TODAY,
    });
    const open = await createTask(db(), {
      ...mine,
      title: "Open",
      dateKind: "open",
      plannedStart: "2026-09-20",
      status: "in_progress",
    });
    const others = await createPlannedTask(db(), {
      trackerId,
      assignees: [other],
      title: "Not mine",
      day: TODAY,
    });
    ids = {
      due: due.taskId,
      dueDay: due.taskDayId,
      spilled,
      window,
      pulled: pulled.taskId,
      early,
      open,
      others: others.taskId,
      othersDay: others.taskDayId,
    };
  });

  const titles = (cards: { title: string }[]) =>
    cards.map((c) => c.title).sort();

  it("day_view gives the caller their own day, in the shape the screens parse", async () => {
    const view = DayViewData.parse(
      await call(me, "select day_view($1) as v", [TODAY]),
    );
    expect(titles(view.rows)).toEqual(["Due today", "Spilled"]);
    expect(titles(view.ongoing)).toEqual(["Open", "Window"]);
    expect(titles(view.pulledForward)).toEqual(["Pulled"]);
    expect(titles(view.earlyDone)).toEqual(["Early"]);
    expect(view).toMatchObject({
      today: TODAY,
      isWorking: true,
      nextWorkingDay: "2026-09-29",
      isAdmin: false,
      hasTasks: true,
    });
    const spill = view.rows.find((c) => c.title === "Spilled")!;
    expect(spill.taskDay).toMatchObject({ spillIndex: 1, locked: false });
    expect(spill.spillCount).toBe(1);
    expect(spill.editable).toBe(true);
    expect(spill.tracker.fileId).toMatch(/^file-/);

    const theirs = DayViewData.parse(
      await call(other, "select day_view($1) as v", [TODAY]),
    );
    expect(titles(theirs.rows)).toEqual(["Not mine"]);
    expect(theirs.ongoing).toEqual([]);
  });

  it("day_view on a Sunday knows it is off, and on a past day keeps only its task-days", async () => {
    const sunday = DayViewData.parse(
      await call(me, "select day_view($1) as v", ["2026-09-27"]),
    );
    expect(sunday).toMatchObject({ isWorking: false, offReason: "Sunday" });
    const past = DayViewData.parse(
      await call(me, "select day_view($1) as v", ["2026-09-24"]),
    );
    expect(titles(past.rows)).toEqual(["Spilled"]);
    expect(past.ongoing).toEqual([]);
    expect(past.pulledForward).toEqual([]);
  });

  it("offers the next three tasks to pull forward", async () => {
    await db().query("delete from task_days where day = $1", [TODAY]);
    await createPlannedTask(db(), {
      trackerId,
      assignees: [me],
      title: "Later",
      day: "2026-10-07",
    });
    const view = DayViewData.parse(
      await call(me, "select day_view($1) as v", [TODAY]),
    );
    expect(view.upcoming.map((c) => c.title)).toEqual(["Window", "Later"]);
  });

  it("refuses callers who are signed out or deactivated", async () => {
    await expect(
      queryAs(db(), { kind: "anon" }, "select day_view($1)", [TODAY]),
    ).rejects.toThrow(/permission denied|not_allowed/);
    await db().query("update app_users set is_active = false where id = $1", [
      me,
    ]);
    await expect(call(me, "select day_view($1) as v", [TODAY])).rejects.toThrow(
      /not_allowed/,
    );
  });

  it("month_view counts the caller's task-days per day", async () => {
    const month = MonthData.parse(
      await call(me, "select month_view($1) as v", ["2026-09-15"]),
    );
    expect(month.days).toHaveLength(30);
    const byDay = new Map(month.days.map((d) => [d.day, d]));
    expect(byDay.get(TODAY)).toMatchObject({ total: 2, open: 2 });
    expect(byDay.get("2026-09-24")).toMatchObject({
      total: 1,
      notDone: 1,
      locked: true,
    });
    expect(byDay.get("2026-09-26")).toMatchObject({
      isWorking: false,
      reason: "4th Saturday",
    });
  });

  it("task_list pages and filters, and only the admin's Everyone reaches other people's tasks", async () => {
    type List = { total: number; rows: { title: string }[] };
    const mine = await call<List>(me, "select task_list($1) as v", [
      { search: "pull" },
    ]);
    expect(mine.total).toBe(1);
    expect(mine.rows.map((r) => r.title)).toEqual(["Pulled"]);
    const all = await call<List>(me, "select task_list($1) as v", [
      { everyone: true },
    ]);
    expect(all.total).toBe(6);
    const everyone = await call<List>(admin, "select task_list($1) as v", [
      { everyone: true, statuses: ["yet_to_start"] },
    ]);
    expect(titles(everyone.rows)).toEqual([
      "Due today",
      "Not mine",
      "Spilled",
      "Window",
    ]);
    const adminsOwn = await call<List>(admin, "select task_list($1) as v", [
      {},
    ]);
    expect(adminsOwn.total).toBe(0);
    // A search is literal text, not a pattern.
    const wildcard = await call<List>(me, "select task_list($1) as v", [
      { search: "%" },
    ]);
    expect(wildcard.total).toBe(0);
  });

  it("task_detail shows the timeline to those who may see the task", async () => {
    await queryAs(db(), as(me), "select set_task_status($1, 'in_progress')", [
      ids.due,
    ]);
    const detail = await call<{
      taskDays: unknown[];
      events: { actor: string; newValue: string }[];
    }>(me, "select task_detail($1) as v", [ids.due]);
    expect(detail.taskDays).toHaveLength(1);
    expect(detail.events.at(-1)).toMatchObject({
      actor: "Me",
      newValue: "in_progress",
    });
    await expect(
      call(other, "select task_detail($1) as v", [ids.due]),
    ).rejects.toThrow(/not_allowed/);
    await expect(
      call(admin, "select task_detail($1) as v", [ids.due]),
    ).resolves.toBeTruthy();
  });

  it("task_sync_status follows the newest write-back, ignoring note refreshes (N17)", async () => {
    await queryAs(db(), as(me), "select set_task_status($1, 'done')", [
      ids.due,
    ]);
    const status = () =>
      call<Record<string, string | null>>(
        me,
        "select task_sync_status($1::uuid[]) as v",
        [`{${ids.due}}`],
      );
    expect(await status()).toEqual({ [ids.due!]: "pending" });
    await db().query("update outbox set state = 'failed' where task_id = $1", [
      ids.due,
    ]);
    expect(await status()).toEqual({ [ids.due!]: "failed" });
    await db().query("update outbox set state = 'done' where task_id = $1", [
      ids.due,
    ]);
    await db().query(
      `insert into outbox (task_id, tracker_id, payload) values ($1, $2, '{"note_only": true}')`,
      [ids.due, trackerId],
    );
    expect(await status()).toEqual({ [ids.due!]: null });
    expect(
      await call(other, "select task_sync_status($1::uuid[]) as v", [
        `{${ids.due}}`,
      ]),
    ).toEqual({});
  });

  it("app_banners: yesterday's close for the admin, paused trackers for those with tasks in them", async () => {
    type Banners = {
      yesterdayNotClosed: boolean;
      paused: { name: string }[];
      openToday: number;
    };
    expect(
      await call<Banners>(admin, "select app_banners() as v"),
    ).toMatchObject({ yesterdayNotClosed: true, paused: [] });
    expect(await call<Banners>(me, "select app_banners() as v")).toMatchObject({
      yesterdayNotClosed: false,
      openToday: 2,
    });
    await db().query(
      "insert into day_closures (day, state) values ('2026-09-27', 'closed')",
    );
    expect(
      await call<Banners>(admin, "select app_banners() as v"),
    ).toMatchObject({ yesterdayNotClosed: false });

    await db().query(
      "update trackers set state = 'paused', pause_reason = 'column ''Status'' not found' where id = $1",
      [trackerId],
    );
    const loner = await createUser(db(), { name: "No tasks" });
    expect(
      (await call<Banners>(me, "select app_banners() as v")).paused,
    ).toEqual([expect.objectContaining({ name: "Filing Buddy" })]);
    expect(
      (await call<Banners>(loner, "select app_banners() as v")).paused,
    ).toEqual([]);
  });

  it("request_sync_now allows one request per 30 seconds per user (7.3)", async () => {
    expect(await call(me, "select to_jsonb(request_sync_now()) as v")).toEqual([
      trackerId,
    ]);
    expect(
      await call(me, "select to_jsonb(request_sync_now()) as v"),
    ).toBeNull();
    expect(
      await call(other, "select to_jsonb(request_sync_now()) as v"),
    ).toEqual([trackerId]);
    await db().query(
      "update sync_now_requests set requested_at = now() - interval '31 seconds' where user_id = $1",
      [me],
    );
    expect(await call(me, "select to_jsonb(request_sync_now()) as v")).toEqual([
      trackerId,
    ]);
    await expect(
      queryAs(db(), as(me), "select * from sync_now_requests"),
    ).rejects.toThrow(/permission denied/);
  });

  it("report_issue raises one member_report per task-day, for the task's own people only", async () => {
    await queryAs(db(), as(me), "select report_issue($1, $2)", [
      ids.dueDay,
      "Marked done by mistake",
    ]);
    await queryAs(db(), as(me), "select report_issue($1, $2)", [
      ids.dueDay,
      "It was done on Friday",
    ]);
    expect(
      await db().query(
        "select kind, detail ->> 'text' as text from attention_items",
      ),
    ).toEqual([{ kind: "member_report", text: "It was done on Friday" }]);
    await expect(
      queryAs(db(), as(other), "select report_issue($1, 'x')", [ids.dueDay]),
    ).rejects.toThrow(/not_allowed/);
    await expect(
      queryAs(db(), as(me), "select report_issue($1, '  ')", [ids.dueDay]),
    ).rejects.toThrow(/reason_required/);
  });

  it("keeps the helpers private", async () => {
    await expect(
      queryAs(db(), as(me), "select knit_can_see($1, true)", [ids.others]),
    ).rejects.toThrow(/permission denied/);
  });
});
