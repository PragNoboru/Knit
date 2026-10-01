import { beforeEach, describe, expect, it } from "vitest";

import { buildDayView, DayViewData } from "@/lib/domain/day-view";
import {
  memoryFile,
  MemorySheetSource,
  type MemoryFile,
} from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";
import { toSheetsSerial } from "@/lib/time";

import { createUser } from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 6.3.4, 6.6, N64 to N67: a tracker with an End date column, pulled and pushed against the
// real SQL. No database change was needed: windows already have planned_end and date_kind.

const TODAY = "2026-09-30"; // Wed
const GO_LIVE = "2026-09-28";

const d = (iso: string) => toSheetsSerial(iso);
const HEADERS = [
  "Task ID",
  "Date",
  "End date",
  "Task",
  "Owner",
  "Status",
  "Done on",
];
const grid = (): (string | number | null)[][] => [
  HEADERS,
  [
    "FBG-03",
    d("2026-10-01"),
    null,
    "Brief the agency",
    "Pragaman",
    "Not started",
    null,
  ],
  [
    "FBG-04",
    d("2026-10-05"),
    d("2026-10-09"),
    "Build the campaigns",
    "Pragaman",
    "In progress",
    null,
  ],
  [
    "FBG-06",
    d("2026-10-13"),
    d("2026-10-18"),
    "Launch week",
    "Pragaman",
    "Not started",
    null,
  ],
  [
    "FBG-07",
    d("2026-10-19"),
    d("2026-10-20"),
    "First review",
    "Pragaman",
    "Blocked",
    null,
  ],
];

const CONFIG = {
  headerRow: 1,
  columns: {
    date: "Date",
    endDate: "End date",
    title: "Task",
    statusRead: "Status",
    statusWrite: "Status",
    completedOn: "Done on",
    owner: "Owner",
    sourceRef: "Task ID",
    critical: null,
  },
  readOnlyColumns: [],
  titleTemplate: "{Task}",
  subtitleTemplate: null,
  detailColumns: [],
  ownerSeparators: [","],
  ownerFilter: "mine",
  offDayPolicy: "previous_working_day",
  statusMap: {
    "not started": "yet_to_start",
    "in progress": "in_progress",
    blocked: "blocked",
    done: "done",
    cancelled: "cancelled",
    "": "yet_to_start",
  },
  cancelReasons: {},
  writeBack: {
    yet_to_start: "Not started",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
  },
  completedOnFormat: { type: "date" },
};

async function setup(db: Db, source: MemorySheetSource, file: MemoryFile) {
  const me = await createUser(db, { role: "member", name: "Pragaman" });
  await db.query(
    "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
    [me],
  );
  const ref: TabRef = { fileId: file.id, sheetId: 0 };
  await source.ensureKnitColumns(ref, 1);
  await db.query(
    `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
    [file.id, file.name],
  );
  const [tracker] = await db.query<{ id: string }>(
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
     values ($1, 0, 'Tasks', 'Standard · Example', 'teal', 'active', $2::jsonb, $3) returning id`,
    [file.id, JSON.stringify(CONFIG), GO_LIVE],
  );
  return { me, ref, trackerId: tracker!.id };
}

describe("a tracker with an End date column (6.3.4)", () => {
  const db = useTestDb();
  let file: MemoryFile;
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    file = memoryFile("Standard example", grid(), { title: "Tasks" });
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
  });

  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({
      states: ["active", "paused"],
      ids: [ctx.trackerId],
    });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  const task = async (ref: string) =>
    (
      await db().query<Record<string, unknown>>(
        `select id::text, date_kind::text, planned_start::text, planned_end::text,
                due_date::text, planned_raw
         from tasks where source_ref = $1`,
        [ref],
      )
    )[0]!;
  const openDays = async (ref: string) =>
    db().query(
      `select d.day::text, d.spill_index from task_days d join tasks k on k.id = d.task_id
       where k.source_ref = $1 and not d.locked order by d.day`,
      [ref],
    );
  /** Everything a pull can change, for "second pull changes nothing". */
  const snapshot = () =>
    db().query(
      `select
         (select jsonb_agg(to_jsonb(k) - 'updated_at' - 'source_synced_at' order by id) from tasks k) as tasks,
         (select jsonb_agg(to_jsonb(d) order by d.id) from task_days d) as days,
         (select count(*)::int from events) as events,
         (select count(*)::int from outbox) as outbox,
         (select count(*)::int from attention_items) as attention`,
    );
  /** The 1-based sheet row of a task by its Task ID. */
  const rowOf = (ref: string) =>
    file.tabs[0]!.rows.findIndex((r) => r[0]?.value === ref) + 1;

  it("stores Date and End date as a window with 'Date to End date' as planned_raw", async () => {
    expect(await pull()).toMatchObject({
      outcome: "pulled",
      stats: { rows: 4, inserted: 4 },
    });
    expect(await task("FBG-04")).toMatchObject({
      date_kind: "window",
      planned_start: "2026-10-05",
      planned_end: "2026-10-09",
      due_date: "2026-10-09",
      planned_raw: "05-Oct-26 to 09-Oct-26",
    });
    expect(await task("FBG-03")).toMatchObject({
      date_kind: "single",
      planned_end: null,
      planned_raw: "01-Oct-26",
    });
    // Sun 18 Oct moves to Sat 17 Oct (a 3rd Saturday); Tue 20 Oct (Dussehra) to Mon 19 Oct.
    expect(await task("FBG-06")).toMatchObject({ due_date: "2026-10-17" });
    expect(await task("FBG-07")).toMatchObject({ due_date: "2026-10-19" });
    expect(await openDays("FBG-06")).toEqual([
      { day: "2026-10-17", spill_index: 0 },
    ]);

    const before = await snapshot();
    expect(await pull()).toMatchObject({
      outcome: "pulled",
      stats: { inserted: 0, updated: 0, removed: 0 },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("shows the window under Ongoing before its last day and under Due today on it (6.3.3, N4, N18)", async () => {
    await pull();
    const dayView = async (day: string) => {
      await setToday(db(), day);
      const [row] = await queryAs<{ v: unknown }>(
        db(),
        { kind: "user", id: ctx.me },
        "select day_view(null) as v",
      );
      return DayViewData.parse(row!.v);
    };
    const titlesOf = (cards: { title: string }[]) => cards.map((c) => c.title);
    const groupOf = (view: DayViewData, title: string) =>
      buildDayView(view).groups.find((g) =>
        g.rows.some((r) => r.card.title === title),
      )?.key;

    const wednesday = await dayView("2026-10-07");
    expect(titlesOf(wednesday.ongoing)).toContain("Build the campaigns");
    // In progress on a later task-day, so it is also pulled forward; it shows once (N18).
    expect(titlesOf(wednesday.pulledForward)).toContain("Build the campaigns");
    expect(groupOf(wednesday, "Build the campaigns")).toBe("ongoing");

    const friday = await dayView("2026-10-09");
    expect(titlesOf(friday.ongoing)).not.toContain("Build the campaigns");
    expect(groupOf(friday, "Build the campaigns")).toBe("due");
  });

  it("moves the open task-day when only the End date changes (N67)", async () => {
    await pull();
    const { id } = await task("FBG-06");
    await source.setCell(
      ctx.ref,
      1,
      rowOf("FBG-06"),
      "End date",
      d("2026-10-22"),
    );
    await pull();
    expect(await task("FBG-06")).toMatchObject({
      date_kind: "window",
      planned_end: "2026-10-22",
      due_date: "2026-10-22",
      planned_raw: "13-Oct-26 to 22-Oct-26",
    });
    expect(await openDays("FBG-06")).toEqual([
      { day: "2026-10-22", spill_index: 0 },
    ]);
    const events = await db().query(
      "select field, old_value, new_value from events where task_id = $1 and field = 'due_date'",
      [id],
    );
    expect(events).toEqual([
      { field: "due_date", old_value: "2026-10-17", new_value: "2026-10-22" },
    ]);
  });

  it("keeps the last good dates and raises bad_date when the End date is before the Date (N65)", async () => {
    await pull();
    const before = await task("FBG-04");
    await source.setCell(
      ctx.ref,
      1,
      rowOf("FBG-04"),
      "End date",
      d("2026-10-02"),
    );
    await pull();
    // The dates stay; planned_raw shows the sheet's text, as for any bad Date (6.6).
    expect(await task("FBG-04")).toEqual({
      ...before,
      planned_raw: "05-Oct-26 to 02-Oct-26",
    });
    expect(await openDays("FBG-04")).toEqual([
      { day: "2026-10-09", spill_index: 0 },
    ]);
    const items = await db().query<{
      kind: string;
      detail: { reason: string };
    }>("select kind, detail from attention_items");
    expect(items).toEqual([
      expect.objectContaining({
        kind: "bad_date",
        detail: expect.objectContaining({
          reason: "range_end_before_start",
          value: "05-Oct-26 to 02-Oct-26",
        }),
      }),
    ]);
  });

  it("pauses the tracker when the End date header is renamed (10.2 step 2)", async () => {
    await pull();
    await source.setCell(ctx.ref, 1, 1, "End date", "Finish");
    expect(await pull()).toMatchObject({
      outcome: "paused",
      reason: "column 'End date' not found",
    });
    const items = await db().query(
      "select kind, dedupe_key from attention_items",
    );
    expect(items).toEqual([
      { kind: "missing_header", dedupe_key: "missing_header:end date" },
    ]);
  });

  it("writes only Status, Done on and the Knit Note on a status change, never Date or End date (invariant 5)", async () => {
    await pull();
    const { id } = await task("FBG-04");
    const row = rowOf("FBG-04");
    const before = file.tabs[0]!.rows[row - 1]!.map((c) => ({ ...c }));
    await queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, 'done'::knit_status, null)",
      [id],
    );
    expect(await pushDue({ store: storeFor(db()), source })).toMatchObject({
      done: 1,
      failed: 0,
    });
    const after = file.tabs[0]!.rows[row - 1]!;
    const headers = file.tabs[0]!.rows[0]!.map((c) => String(c.value));
    const changed = headers.filter(
      (_h, i) =>
        JSON.stringify(after[i] ?? null) !== JSON.stringify(before[i] ?? null),
    );
    expect(changed.sort()).toEqual(["Done on", "Knit Note", "Status"]);
    expect(after[headers.indexOf("Date")]).toEqual(
      before[headers.indexOf("Date")],
    );
    expect(after[headers.indexOf("End date")]).toEqual(
      before[headers.indexOf("End date")],
    );
  });
});
