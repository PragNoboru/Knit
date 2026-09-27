import { beforeEach, describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTask,
  createTracker,
  createUser,
} from "./support/builders";
import { queryAs, setToday, useTestDb } from "./support/db";

// PRD 6.11, 11, 12.8 (M8): the admin functions, and that only the admin reaches them.

const TODAY = "2026-10-05"; // Mon

describe("admin functions", () => {
  const db = useTestDb();
  let admin: string;
  let member: string;
  let trackerId: string;

  const as = (user: string) => ({ kind: "user" as const, id: user });
  const call = async <T = unknown>(
    user: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T> => {
    const [row] = await queryAs<{ v: T }>(db(), as(user), sql, params);
    return row!.v;
  };
  const service = (sql: string, params: unknown[] = []) =>
    queryAs(db(), { kind: "service" }, sql, params);

  beforeEach(async () => {
    admin = await createUser(db(), { role: "admin", name: "Admin" });
    member = await createUser(db(), { name: "Member" });
    trackerId = await createTracker(db(), {
      name: "Filing Buddy",
      goLiveDate: "2026-10-01",
    });
    await setToday(db(), TODAY);
  });

  it("refuses members everywhere", async () => {
    for (const sql of [
      "select admin_trackers()",
      "select admin_sync_health()",
      "select admin_attention()",
      `select admin_backlog('${trackerId}')`,
      "select admin_retry_writes()",
      "select holiday_impact('2026-10-20')",
      `select backlog_action(array['${trackerId}']::uuid[], 'mark_done')`,
    ]) {
      await expect(queryAs(db(), as(member), sql)).rejects.toThrow(
        /not_allowed/,
      );
    }
    await expect(
      queryAs(
        db(),
        as(admin),
        `select set_tracker_state('${trackerId}', 'paused')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("admin_trackers lists trackers with counts, and new sheets", async () => {
    await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: TODAY,
    });
    await createTask(db(), {
      trackerId,
      historyOnly: true,
      dueDate: "2026-09-25",
    });
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values
         ('new-sheet', 'Sapiens', 'application/vnd.google-apps.spreadsheet', 'new'),
         ('a-pdf', 'Brief.pdf', 'application/pdf', 'not_a_sheet')`,
    );
    const data = await call<{
      trackers: { name: string; taskCount: number; backlogCount: number }[];
      files: { name: string; state: string }[];
    }>(admin, "select admin_trackers() as v");
    expect(data.trackers).toEqual([
      expect.objectContaining({
        name: "Filing Buddy",
        taskCount: 2,
        backlogCount: 1,
      }),
    ]);
    expect(data.files.map((f) => [f.name, f.state])).toEqual([
      ["Brief.pdf", "not_a_sheet"],
      ["Sapiens", "new"],
    ]);
    await queryAs(
      db(),
      as(admin),
      "select admin_set_file_state('new-sheet', 'ignored')",
    );
    expect(
      await db().query(
        "select state::text from drive_files where file_id = 'new-sheet'",
      ),
    ).toEqual([{ state: "ignored" }]);
  });

  it("set_tracker_state pauses and resumes, releasing held write-backs (10.4, 12.8)", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: TODAY,
    });
    await service(
      `select set_tracker_state('${trackerId}', 'paused', 'Paused by the admin')`,
    );
    await db().query(
      `insert into outbox (task_id, tracker_id, payload, state) values ($1, $2, '{}', 'held')`,
      [taskId, trackerId],
    );
    await db().query(
      `insert into attention_items (tracker_id, kind, dedupe_key) values ($1, 'missing_header', 'missing_header:status')`,
      [trackerId],
    );
    expect(
      await db().query(
        "select state::text, pause_reason from trackers where id = $1",
        [trackerId],
      ),
    ).toEqual([{ state: "paused", pause_reason: "Paused by the admin" }]);
    await service(`select set_tracker_state('${trackerId}', 'active')`);
    expect(
      await db().query(
        "select state::text, pause_reason from trackers where id = $1",
        [trackerId],
      ),
    ).toEqual([{ state: "active", pause_reason: null }]);
    expect(await db().query("select state::text from outbox")).toEqual([
      { state: "pending" },
    ]);
    expect(await db().query("select state from attention_items")).toEqual([
      { state: "resolved" },
    ]);
    await service(`select set_tracker_state('${trackerId}', 'archived')`);
    await expect(
      service(`select set_tracker_state('${trackerId}', 'active')`),
    ).rejects.toThrow(/invalid_transition/);
  });

  it("set_tracker_state does not resume a tracker whose sheet is still outside the Knit folder (10.1, D14)", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: TODAY,
    });
    await db().query(
      "update drive_files set state = 'left_folder' where file_id = (select file_id from trackers where id = $1)",
      [trackerId],
    );
    await service(
      `select set_tracker_state('${trackerId}', 'paused', 'Left the Knit folder')`,
    );
    await db().query(
      `insert into outbox (task_id, tracker_id, payload, state) values ($1, $2, '{}', 'held')`,
      [taskId, trackerId],
    );
    await expect(
      service(`select set_tracker_state('${trackerId}', 'active')`),
    ).rejects.toThrow(/file_outside_folder/);
    expect(
      await db().query("select state::text from trackers where id = $1", [
        trackerId,
      ]),
    ).toEqual([{ state: "paused" }]);
    expect(await db().query("select state::text from outbox")).toEqual([
      { state: "held" },
    ]);
    // Back in the folder (discover marks it connected): Resume works.
    await db().query(
      "update drive_files set state = 'connected' where file_id = (select file_id from trackers where id = $1)",
      [trackerId],
    );
    await service(`select set_tracker_state('${trackerId}', 'active')`);
    expect(await db().query("select state::text from outbox")).toEqual([
      { state: "pending" },
    ]);
    // It can still be archived while the sheet is out.
    await service(
      `select set_tracker_state('${trackerId}', 'paused', 'Left the Knit folder')`,
    );
    await db().query(
      "update drive_files set state = 'left_folder' where file_id = (select file_id from trackers where id = $1)",
      [trackerId],
    );
    await service(`select set_tracker_state('${trackerId}', 'archived')`);
  });

  it("admin_retry_writes sends the newest failed write-back again and closes its item", async () => {
    const { taskId } = await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: TODAY,
    });
    await db().query(
      `insert into outbox (task_id, tracker_id, payload, state, attempts) values
         ($1, $2, '{"status_value": "Done"}', 'failed', 5),
         ($1, $2, '{"status_value": "Blocked"}', 'failed', 5)`,
      [taskId, trackerId],
    );
    await db().query(
      `insert into attention_items (tracker_id, task_id, kind, dedupe_key) values ($1, $2, 'write_blocked', 'write_blocked:x')`,
      [trackerId, taskId],
    );
    expect(await call(admin, "select admin_retry_writes() as v")).toBe(1);
    expect(
      await db().query("select state::text, attempts from outbox order by id"),
    ).toEqual([
      { state: "failed", attempts: 5 },
      { state: "pending", attempts: 0 },
    ]);
    expect(await db().query("select state from attention_items")).toEqual([
      { state: "resolved" },
    ]);
  });

  it("admin_attention lists open items with where they happened, and they can be dismissed", async () => {
    const taskId = await createTask(db(), {
      trackerId,
      title: "Account assets",
    });
    await db().query(
      `insert into attention_items (tracker_id, task_id, kind, dedupe_key, detail) values
         ($1, $2, 'member_report', 'member_report:1', jsonb_build_object('text', 'Done on Friday', 'userId', $3::text))`,
      [trackerId, taskId, member],
    );
    const [item] = await call<
      {
        id: number;
        tracker: { name: string };
        task: { title: string };
        reporter: string;
      }[]
    >(admin, "select admin_attention() as v");
    expect(item).toMatchObject({
      tracker: { name: "Filing Buddy" },
      task: { title: "Account assets" },
      reporter: "Member",
    });
    await queryAs(
      db(),
      as(admin),
      "select admin_set_attention_state($1, 'dismissed')",
      [item!.id],
    );
    expect(await call(admin, "select admin_attention() as v")).toEqual([]);
  });

  it("backlog_action brings old rows to today, or closes them with a write-back (6.11)", async () => {
    const bring = await createTask(db(), {
      trackerId,
      title: "Old but open",
      historyOnly: true,
      dueDate: "2026-09-25",
      status: "in_progress",
    });
    const done = await createTask(db(), {
      trackerId,
      title: "Old and finished",
      historyOnly: true,
      dueDate: "2026-09-24",
    });
    const cancel = await createTask(db(), {
      trackerId,
      title: "Old and dropped",
      historyOnly: true,
      dueDate: "2026-09-23",
    });
    const backlog = await call<{ title: string }[]>(
      admin,
      "select admin_backlog($1) as v",
      [trackerId],
    );
    expect(backlog.map((c) => c.title)).toEqual([
      "Old and dropped",
      "Old and finished",
      "Old but open",
    ]);

    await queryAs(
      db(),
      as(admin),
      "select backlog_action($1::uuid[], 'bring_to_today')",
      [`{${bring}}`],
    );
    expect(
      await db().query(
        "select day::text, status::text, spill_index, origin from task_days where task_id = $1",
        [bring],
      ),
    ).toEqual([
      { day: TODAY, status: "in_progress", spill_index: 1, origin: "backlog" },
    ]);
    expect(
      await db().query("select history_only from tasks where id = $1", [bring]),
    ).toEqual([{ history_only: false }]);

    await queryAs(
      db(),
      as(admin),
      "select backlog_action($1::uuid[], 'mark_done')",
      [`{${done}}`],
    );
    expect(
      await db().query(
        "select status::text, completed_on::text, history_only from tasks where id = $1",
        [done],
      ),
    ).toEqual([{ status: "done", completed_on: TODAY, history_only: true }]);
    expect(
      await db().query("select payload from outbox where task_id = $1", [done]),
    ).toEqual([{ payload: { status_value: "Done", completed_on: TODAY } }]);

    await expect(
      queryAs(db(), as(admin), "select backlog_action($1::uuid[], 'cancel')", [
        `{${cancel}}`,
      ]),
    ).rejects.toThrow(/reason_required/);
    await queryAs(
      db(),
      as(admin),
      "select backlog_action($1::uuid[], 'cancel', 'No longer needed')",
      [`{${cancel}}`],
    );
    expect(
      await db().query(
        "select status::text, status_reason from tasks where id = $1",
        [cancel],
      ),
    ).toEqual([{ status: "cancelled", status_reason: "No longer needed" }]);
    expect(
      await call(admin, "select admin_backlog($1) as v", [trackerId]),
    ).toEqual([]);
  });

  it("holiday_impact counts the open tasks a new holiday would move", async () => {
    await createPlannedTask(db(), {
      trackerId,
      assignees: [member],
      day: "2026-10-21",
    });
    expect(
      await call(admin, "select holiday_impact('2026-10-21') as v"),
    ).toEqual({ openTaskDays: 1, lockedTaskDays: 0, plannedTasks: 1 });
  });

  it("admin_sync_health reports write-backs, closes and the calendar's end", async () => {
    await db().query(
      "insert into day_closures (day, state) values ('2026-10-02', 'closed')",
    );
    const health = await call<{
      outbox: Record<string, number>;
      closures: { day: string }[];
      calendarEnd: string;
    }>(admin, "select admin_sync_health() as v");
    expect(health.outbox).toMatchObject({ pending: 0, failed: 0 });
    expect(health.closures.map((c) => c.day)).toEqual(["2026-10-02"]);
    expect(health.calendarEnd).toBe("2027-12-31");
  });
});
