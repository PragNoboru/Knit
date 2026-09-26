import { beforeEach, describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTracker,
  createUser,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Actor } from "./support/db";

// PRD 9.2 with the clarifications of 25 Sep 2026 (task_assignees, people_aliases).
describe("row level security (PRD 9.2)", () => {
  const db = useTestDb();
  let alice: string;
  let bob: string;
  let admin: string;
  let aliceTask: string;
  let bobTask: string;
  let aliceTracker: string;
  let bobTracker: string;

  const as = (id: string): Actor => ({ kind: "user", id });
  const anon: Actor = { kind: "anon" };

  beforeEach(async () => {
    await setToday(db(), "2026-09-30");
    alice = await createUser(db(), { role: "member", name: "Alice" });
    bob = await createUser(db(), { role: "member", name: "Bob" });
    admin = await createUser(db(), { role: "admin", name: "Admin" });
    aliceTracker = await createTracker(db(), { name: "Alice's tracker" });
    bobTracker = await createTracker(db(), { name: "Bob's tracker" });
    aliceTask = (
      await createPlannedTask(db(), {
        trackerId: aliceTracker,
        assignees: [alice],
      })
    ).taskId;
    bobTask = (
      await createPlannedTask(db(), { trackerId: bobTracker, assignees: [bob] })
    ).taskId;
    // One event per task, as a status change would leave.
    await queryAs(
      db(),
      as(alice),
      "select set_task_status($1, 'in_progress')",
      [aliceTask],
    );
    await queryAs(db(), as(bob), "select set_task_status($1, 'in_progress')", [
      bobTask,
    ]);
  });

  const ids = (rows: Record<string, unknown>[], key = "id") =>
    rows.map((row) => String(row[key])).sort();

  it("a member reads only their own tasks, task-days and events", async () => {
    expect(ids(await queryAs(db(), as(alice), "select id from tasks"))).toEqual(
      [aliceTask],
    );
    expect(
      ids(
        await queryAs(db(), as(alice), "select task_id from task_days"),
        "task_id",
      ),
    ).toEqual([aliceTask]);
    expect(
      ids(
        await queryAs(db(), as(alice), "select task_id from events"),
        "task_id",
      ),
    ).toEqual([aliceTask]);
    expect(
      ids(
        await queryAs(db(), as(alice), "select task_id from task_assignees"),
        "task_id",
      ),
    ).toEqual([aliceTask]);
    // Asking for Bob's task by id returns nothing.
    expect(
      await queryAs(db(), as(alice), "select id from tasks where id = $1", [
        bobTask,
      ]),
    ).toEqual([]);
  });

  it("the admin reads every task", async () => {
    expect(ids(await queryAs(db(), as(admin), "select id from tasks"))).toEqual(
      [aliceTask, bobTask].sort(),
    );
  });

  it("a deactivated member reads nothing", async () => {
    await db().query("update app_users set is_active = false where id = $1", [
      alice,
    ]);
    expect(await queryAs(db(), as(alice), "select id from tasks")).toEqual([]);
    expect(
      await queryAs(db(), as(alice), "select id from tracker_public"),
    ).toEqual([]);
  });

  it("a member reads their own app_users row only; the admin reads all", async () => {
    expect(
      ids(await queryAs(db(), as(alice), "select id from app_users")),
    ).toEqual([alice]);
    expect(
      await queryAs(db(), as(admin), "select id from app_users"),
    ).toHaveLength(3);
  });

  it("members see tracker names and colours only through tracker_public, and only their own", async () => {
    expect(await queryAs(db(), as(alice), "select id from trackers")).toEqual(
      [],
    );
    expect(
      await queryAs(
        db(),
        as(alice),
        "select id, name, color from tracker_public",
      ),
    ).toEqual([{ id: aliceTracker, name: "Alice's tracker", color: "amber" }]);
    expect(
      await queryAs(db(), as(admin), "select id from tracker_public"),
    ).toHaveLength(2);
  });

  it("members cannot write through tracker_public", async () => {
    await expect(
      queryAs(db(), as(alice), "update tracker_public set name = 'Renamed'"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    "people_aliases",
    "settings",
    "drive_files",
    "outbox",
    "sync_runs",
    "day_closures",
    "attention_items",
    "job_leases",
  ])("%s is admin-only", async (table) => {
    expect(await queryAs(db(), as(alice), `select * from ${table}`)).toEqual(
      [],
    );
    const adminRows = await queryAs(
      db(),
      as(admin),
      `select count(*)::int as n from ${table}`,
    );
    expect(adminRows).toHaveLength(1);
  });

  it("the admin sees the outbox rows members' changes queued", async () => {
    expect(
      await queryAs(db(), as(admin), "select count(*)::int as n from outbox"),
    ).toEqual([{ n: 2 }]);
  });

  it("members read holidays and the calendar", async () => {
    expect(
      await queryAs(db(), as(alice), "select count(*)::int as n from holidays"),
    ).toEqual([{ n: 10 }]);
    expect(
      await queryAs(
        db(),
        as(alice),
        "select count(*)::int as n from calendar_days",
      ),
    ).toEqual([{ n: 730 }]);
  });

  it.each([
    [
      "insert",
      "insert into tasks (id, tracker_id, title) values (gen_random_uuid(), $1, 'x')",
    ],
    ["update", "update tasks set title = 'hacked' where id = $1"],
    ["delete", "delete from task_days where task_id = $1"],
    ["insert", "insert into task_assignees (task_id, user_id) values ($1, $1)"],
    ["update", "update app_users set role = 'admin' where id = $1"],
  ])(
    "signed-in users cannot %s tables directly (invariant 9)",
    async (_verb, sql) => {
      const param = sql.includes("tracker_id")
        ? aliceTracker
        : sql.includes("app_users")
          ? alice
          : aliceTask;
      await expect(
        queryAs(db(), as(alice), sql, [param]),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  it("the anonymous role reads nothing at all", async () => {
    for (const table of [
      "tasks",
      "task_days",
      "app_users",
      "holidays",
      "calendar_days",
      "trackers",
      "tracker_public",
    ]) {
      await expect(
        queryAs(db(), anon, `select * from ${table}`),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("anonymous callers cannot run the RPC functions", async () => {
    await expect(
      queryAs(db(), anon, "select knit_today()"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      queryAs(db(), anon, "select set_task_status($1, 'done')", [aliceTask]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
