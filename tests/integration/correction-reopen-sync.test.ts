import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 10.3, 6.10, Q6 (resolved 1 Oct 2026), N24, N27: the sheet reopening a finished task is a
// conflict; the admin's correction on the day the task ended reopens it, resolves the item,
// and the pull and push that follow agree with it.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const MONDAY = "2026-09-28";
const TUESDAY = "2026-09-29";

async function setup(db: Db, source: MemorySheetSource, file: MemoryFile) {
  const me = await createUser(db, { role: "member", name: "Pragaman" });
  const admin = await createUser(db, { role: "admin", name: "Admin" });
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
     values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', 'active', $2::jsonb, $3) returning id`,
    [
      file.id,
      JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
      MONDAY,
    ],
  );
  return { me, admin, ref, trackerId: tracker!.id };
}

describe("the sheet reopens a finished task (PRD 10.3, 6.10)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;
  let g01: string;

  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  const push = () => pushDue({ store: storeFor(db()), source });
  const sheetRow = async () => {
    const rows = await source.readRows(ctx.ref, 1);
    const row = rows.find((r) => r.cells["knit id"]?.value === g01)!;
    return {
      status: row.cells.status!.formatted,
      doneOn: row.cells["done on"]!.formatted,
      note: row.cells["knit note"]!.formatted,
    };
  };
  const items = () =>
    db().query(
      `select kind, state, detail ->> 'reason' as reason from attention_items
       where task_id = $1 order by id`,
      [g01],
    );
  const taskRow = () =>
    db()
      .query(
        "select status::text, completed_on::text from tasks where id = $1",
        [g01],
      )
      .then((rows) => rows[0]);
  const pendingWriteBacks = () =>
    db().query(
      "select payload from outbox where task_id = $1 and state = 'pending' order by id",
      [g01],
    );
  const correctMonday = async (status: string, reason: string) => {
    const [day] = await db().query<{ id: string }>(
      "select id::text from task_days where task_id = $1 and day = $2",
      [g01, MONDAY],
    );
    await queryAs(
      db(),
      { kind: "user", id: ctx.admin },
      "select admin_correct_task_day($1::bigint, $2::knit_status, $3)",
      [day!.id, status, reason],
    );
  };

  // G01 (planned Mon 28 Sep) is done on Monday and written to the sheet; Monday closes.
  beforeEach(async () => {
    await setToday(db(), MONDAY);
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
    await pull();
    const [row] = await db().query<{ id: string }>(
      "select id::text from tasks where source_ref = 'G01'",
    );
    g01 = row!.id;
    await queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, 'done')",
      [g01],
    );
    await push();
    expect(await sheetRow()).toMatchObject({
      status: "Done",
      doneOn: "Mon 28 Sep",
    });
    await setToday(db(), TUESDAY);
    await queryAs(db(), { kind: "service" }, "select close_day($1)", [MONDAY]);
    await push(); // the close's Knit Note refresh (N17)
  });

  it("the correction reopens it, resolves the item, and a pull that sees the sheet agree raises nothing (N27)", async () => {
    await source.setCell(ctx.ref, 1, 2, "Status", "In progress");
    await source.setCell(ctx.ref, 1, 2, "Done on", "");
    await pull();
    expect(await taskRow()).toEqual({
      status: "done",
      completed_on: MONDAY,
    });
    expect(await items()).toEqual([
      { kind: "conflict", state: "open", reason: "reopened_in_source" },
    ]);

    await correctMonday("in_progress", "The sheet is right");
    expect(await taskRow()).toEqual({
      status: "in_progress",
      completed_on: null,
    });
    expect((await taskDays(db(), g01)).map((d) => [d.day, d.locked])).toEqual([
      [MONDAY, true],
      [TUESDAY, false],
    ]);
    expect(await items()).toEqual([
      { kind: "conflict", state: "resolved", reason: "reopened_in_source" },
    ]);

    expect(await pull()).toMatchObject({ stats: { conflicts: 0 } });
    expect(await items()).toHaveLength(1);
    expect(await pendingWriteBacks()).toEqual([
      { payload: { status_value: "In progress", completed_on: null } },
    ]);

    await push();
    expect(await sheetRow()).toEqual({
      status: "In progress",
      doneOn: "",
      note: "Spilled 1x · now due Tue 29 Sep · In progress",
    });
  });

  it("a sheet still showing the old Done on date is a plain conflict, and the push clears the cell (N24)", async () => {
    await source.setCell(ctx.ref, 1, 2, "Status", "In progress");
    await pull();
    await correctMonday("in_progress", "The sheet is right");

    // The resolved item no longer holds the task's conflict key.
    expect(await pull()).toMatchObject({ stats: { conflicts: 1 } });
    expect(await items()).toEqual([
      { kind: "conflict", state: "resolved", reason: "reopened_in_source" },
      { kind: "conflict", state: "open", reason: null },
    ]);

    await push();
    expect(await sheetRow()).toMatchObject({
      status: "In progress",
      doneOn: "",
    });
  });
});
