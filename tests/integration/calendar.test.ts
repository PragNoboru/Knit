import { describe, expect, it } from "vitest";

import {
  createPlannedTask,
  createTask,
  createTaskDay,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import { act, queryAs, setToday, useTestDb } from "./support/db";

// PRD 6.2, D11, N2: working days are Mon to Fri plus the 1st and 3rd Saturday, minus holidays.
// October 2026 checked day by day, written out by hand (PRD 17).
const OCTOBER_2026_OFF_DAYS: Record<string, string> = {
  "2026-10-02": "Gandhi Jayanti",
  "2026-10-04": "Sunday",
  "2026-10-10": "2nd Saturday",
  "2026-10-11": "Sunday",
  "2026-10-18": "Sunday",
  "2026-10-20": "Dussehra",
  "2026-10-24": "4th Saturday",
  "2026-10-25": "Sunday",
  "2026-10-31": "5th Saturday",
};

describe("working-day calendar (PRD 6.2)", () => {
  const db = useTestDb();

  it("covers 2026-01-01 to 2027-12-31, one row per day", async () => {
    const [range] = await db().query<{
      first: string;
      last: string;
      days: number;
    }>(
      "select min(day)::text as first, max(day)::text as last, count(*)::int as days from calendar_days",
    );
    expect(range).toEqual({
      first: "2026-01-01",
      last: "2027-12-31",
      days: 730,
    });
  });

  it("matches the hand-written October 2026 calendar", async () => {
    const rows = await db().query<{
      day: string;
      is_working: boolean;
      reason: string | null;
    }>(
      `select day::text, is_working, reason from calendar_days
       where day between '2026-10-01' and '2026-10-31' order by day`,
    );
    expect(rows).toHaveLength(31);
    for (const row of rows) {
      const offReason = OCTOBER_2026_OFF_DAYS[row.day];
      expect({
        day: row.day,
        working: row.is_working,
        reason: row.reason,
      }).toEqual({
        day: row.day,
        working: offReason === undefined,
        reason: offReason ?? null,
      });
    }
    expect(rows.filter((row) => row.is_working)).toHaveLength(22);
  });

  it.each([
    ["2026-10-03", true, null], // 1st Saturday works
    ["2026-10-17", true, null], // 3rd Saturday works
    ["2026-08-15", false, "Independence Day"], // a holiday on a working (3rd) Saturday
    ["2026-11-08", false, "Diwali"], // a holiday on a Sunday keeps the holiday's name
    ["2027-01-30", false, "5th Saturday"],
    ["2027-01-01", false, "New Year (Hangover Day)"],
  ])("%s: working %s, reason %s", async (day, working, reason) => {
    const [row] = await db().query(
      "select is_working, reason from calendar_days where day = $1",
      [day],
    );
    expect(row).toEqual({ is_working: working, reason });
  });

  it.each([
    ["next_working_day", "2026-10-01", "2026-10-03"], // skips Gandhi Jayanti
    ["next_working_day", "2026-10-03", "2026-10-05"], // skips Sunday
    ["next_working_day", "2026-10-09", "2026-10-12"], // skips the 2nd Saturday and Sunday
    ["next_working_day", "2026-10-30", "2026-11-02"], // skips the 5th Saturday and Sunday
    ["prev_working_day", "2026-10-02", "2026-10-01"],
    ["prev_working_day", "2026-10-25", "2026-10-23"], // Sat 24 Oct is a 4th Saturday
    ["prev_working_day", "2026-11-08", "2026-11-07"], // Sat 7 Nov is a 1st Saturday
    ["prev_working_day", "2026-11-01", "2026-10-30"],
  ])("%s(%s) = %s", async (fn, day, expected) => {
    const [row] = await db().query<{ result: string }>(
      `select ${fn}($1)::text as result`,
      [day],
    );
    expect(row?.result).toBe(expected);
  });

  it("refuses dates the calendar does not cover instead of guessing", async () => {
    await expect(
      db().query("select is_working_day('2028-01-03')"),
    ).rejects.toMatchObject({
      message: "calendar_not_covered",
    });
  });

  it("refuses a next working day beyond the calendar's end", async () => {
    await db().query("savepoint s");
    await expect(
      db().query("select next_working_day('2027-12-31')"),
    ).rejects.toMatchObject({
      message: "calendar_not_covered",
    });
    await db().query("rollback to savepoint s");
  });
});

describe("knit_today (PRD 9.1, invariant 1)", () => {
  const db = useTestDb();

  it("is the date in Asia/Kolkata", async () => {
    const [row] = await db().query<{ same: boolean }>(
      "select knit_today() = (now() at time zone 'Asia/Kolkata')::date as same",
    );
    expect(row?.same).toBe(true);
  });

  it("can be frozen by a test for one transaction", async () => {
    await setToday(db(), "2026-10-05");
    const [row] = await db().query<{ today: string }>(
      "select knit_today()::text as today",
    );
    expect(row?.today).toBe("2026-10-05");
  });
});

describe("refresh_calendar and holidays (PRD 6.2, 9.1, 9.2)", () => {
  const db = useTestDb();

  it("is refused to members and to anonymous callers", async () => {
    const member = await createUser(db(), { role: "member" });
    await expect(
      queryAs(
        db(),
        { kind: "user", id: member },
        "select refresh_calendar('2026-10-01', '2026-10-31')",
      ),
    ).rejects.toMatchObject({ message: "not_allowed", code: "42501" });
    await expect(
      queryAs(
        db(),
        { kind: "anon" },
        "select refresh_calendar('2026-10-01', '2026-10-31')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("gives the same rows when run again", async () => {
    const before = await db().query(
      "select day::text, is_working, reason from calendar_days order by day",
    );
    await db().query("select refresh_calendar('2026-01-01', '2027-12-31')");
    const after = await db().query(
      "select day::text, is_working, reason from calendar_days order by day",
    );
    expect(after).toEqual(before);
  });

  it("follows the admin's holiday edits at once", async () => {
    const admin = await createUser(db(), { role: "admin" });
    const asAdmin = { kind: "user", id: admin } as const;

    await queryAs(
      db(),
      asAdmin,
      "insert into holidays (day, name) values ('2026-12-25', 'Christmas')",
    );
    const [added] = await db().query(
      "select is_working, reason from calendar_days where day = '2026-12-25'",
    );
    expect(added).toEqual({ is_working: false, reason: "Christmas" });

    await queryAs(
      db(),
      asAdmin,
      "delete from holidays where day = '2026-12-25'",
    );
    const [removed] = await db().query(
      "select is_working, reason from calendar_days where day = '2026-12-25'",
    );
    expect(removed).toEqual({ is_working: true, reason: null });
  });

  it("moves the open spillovers off a day that becomes a holiday (12.8, 6.4)", async () => {
    const admin = await createUser(db(), { role: "admin" });
    const trackerId = await createTracker(db());
    // Sat 10 Oct (off). Fri 9 Oct closed and spilled to Mon 12 Oct.
    await setToday(db(), "2026-10-10");
    const spilled = async (status: string, statusChangedOn?: string) => {
      const taskId = await createTask(db(), {
        trackerId,
        dueDate: "2026-10-09",
        status,
      });
      await createTaskDay(db(), {
        taskId,
        day: "2026-10-09",
        status: "not_done",
        locked: true,
      });
      await createTaskDay(db(), {
        taskId,
        day: "2026-10-12",
        status,
        spillIndex: 1,
        origin: "spillover",
        statusChangedOn: statusChangedOn ?? null,
      });
      return taskId;
    };
    const open = await spilled("in_progress");
    const finished = await spilled("done", "2026-10-10");
    const clash = await spilled("yet_to_start");
    await createTaskDay(db(), { taskId: clash, day: "2026-10-13" });
    // A planned task-day follows its recomputed due date on the pull (6.3.3), not here.
    const planned = await createPlannedTask(db(), {
      trackerId,
      day: "2026-10-12",
    });
    const [before] = await db().query<{ v: string }>(
      "select state_version::text as v from trackers where id = $1",
      [trackerId],
    );

    await queryAs(
      db(),
      { kind: "user", id: admin },
      "insert into holidays (day, name) values ('2026-10-12', 'Office closed')",
    );

    const onDays = async (taskId: string) =>
      (await taskDays(db(), taskId)).map((d) => [d.day, d.status]);
    expect(await onDays(open)).toEqual([
      ["2026-10-09", "not_done"],
      ["2026-10-13", "in_progress"],
    ]);
    expect(await onDays(finished)).toEqual([
      ["2026-10-09", "not_done"],
      ["2026-10-12", "done"],
    ]);
    expect(await onDays(clash)).toEqual([
      ["2026-10-09", "not_done"],
      ["2026-10-12", "yet_to_start"],
      ["2026-10-13", "yet_to_start"],
    ]);
    expect(await onDays(planned.taskId)).toEqual([
      ["2026-10-12", "yet_to_start"],
    ]);
    expect(
      await db().query(
        `select task_id::text, origin::text, field, old_value, new_value, reason
         from events`,
      ),
    ).toEqual([
      {
        task_id: open,
        origin: "system",
        field: "due_date",
        old_value: "2026-10-12",
        new_value: "2026-10-13",
        reason: "Office closed",
      },
    ]);
    expect(
      await db().query(
        "select task_id::text, kind, detail ->> 'reason' as reason from attention_items",
      ),
    ).toEqual([
      { task_id: clash, kind: "bad_date", reason: "day_already_used" },
    ]);
    const [after] = await db().query<{ v: string }>(
      "select state_version::text as v from trackers where id = $1",
      [trackerId],
    );
    expect(Number(after!.v)).toBe(Number(before!.v) + 1);
  });

  it("does not let members edit holidays", async () => {
    const member = await createUser(db(), { role: "member" });
    await expect(
      queryAs(
        db(),
        { kind: "user", id: member },
        "insert into holidays (day, name) values ('2026-12-25', 'Christmas')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const rows = await act(db(), { kind: "user", id: member }, () =>
      db().query("select count(*)::int as n from holidays"),
    );
    expect(rows[0]).toEqual({ n: 10 });
  });
});

describe("TypeScript calendar rules match the database (PRD 6.2)", () => {
  const db = useTestDb();

  it("agree on every day of 2026 and 2027", async () => {
    const { calendarDaysFromRules } = await import("@/lib/domain/calendar");
    const holidays = await db().query<{ date: string; name: string }>(
      "select day::text as date, name from holidays order by day",
    );
    const fromDb = await db().query<{
      day: string;
      isWorking: boolean;
      reason: string | null;
    }>(
      `select day::text, is_working as "isWorking", reason from calendar_days order by day`,
    );
    expect(calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31")).toEqual(
      fromDb,
    );
  });
});
