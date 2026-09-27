import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type TabRef,
} from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";
import { structureCheckAll } from "@/lib/sync/structure-job";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 10.2 step 2, 7.3, 11 step 9, 14, N6, D7: the structure check in the pull, the push and
// the daily structure job, and where activation puts the Knit columns, against the real SQL.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const TODAY = "2026-09-28";
const STATUS = 8; // column I
const DONE_ON = 9; // column J

async function connect(
  db: Db,
  source: MemorySheetSource,
  file: MemoryFile,
  sheetGid = 0,
) {
  await db.query(
    `insert into drive_files (file_id, name, mime_type, state)
     values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')
     on conflict (file_id) do nothing`,
    [file.id, file.name],
  );
  const [tracker] = await db.query<{ id: string }>(
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
     values ($1, $2, 'Copy of Google', $3, 'amber', 'active', $4::jsonb, $5) returning id`,
    [
      file.id,
      sheetGid,
      `Filing Buddy · Google Ads ${sheetGid}`,
      JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
      TODAY,
    ],
  );
  return tracker!.id;
}

async function setup(db: Db, source: MemorySheetSource, file: MemoryFile) {
  const me = await createUser(db, { role: "member", name: "Pragaman" });
  await db.query(
    "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
    [me],
  );
  const ref: TabRef = { fileId: file.id, sheetId: 0 };
  await source.ensureKnitColumns(ref, 1);
  const trackerId = await connect(db, source, file);
  const store = storeFor(db);
  const [synced] = await store.trackers({ ids: [trackerId] });
  await pullTracker({ store, source }, synced!, { force: true });
  return { me, ref, trackerId };
}

/** Someone types a formula into every data cell of a column. */
function addFormulas(file: MemoryFile, column: number) {
  for (const row of file.tabs[0]!.rows.slice(1)) {
    if (row.some((cell) => cell.value !== null))
      row[column] = { ...row[column]!, formula: '=IF(TRUE,"x","")' };
  }
}

describe("structure check (PRD 10.2 step 2, 14)", () => {
  const db = useTestDb();
  let file: MemoryFile;
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
  });

  const store = () => storeFor(db());
  const push = () => pushDue({ store: store(), source });
  const pull = async () => {
    const [tracker] = await store().trackers({
      states: ["active", "paused"],
      ids: [ctx.trackerId],
    });
    return pullTracker({ store: store(), source }, tracker!, { force: true });
  };
  const taskId = async (sourceRef: string) =>
    (
      await db().query<{ id: string }>(
        "select id::text from tasks where source_ref = $1",
        [sourceRef],
      )
    )[0]!.id;
  const setStatus = (id: string, status: string) =>
    queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, $2::knit_status, null)",
      [id, status],
    );
  const tracker = async () =>
    (
      await db().query(
        "select state::text, pause_reason from trackers where id = $1",
        [ctx.trackerId],
      )
    )[0];
  const attention = () =>
    db().query("select kind, dedupe_key from attention_items order by id");
  const knitNoteIndex = () =>
    file.tabs[0]!.rows[0]!.findIndex((c) => c?.value === KNIT_NOTE_HEADER);
  const sheetRow = async (id: string) => {
    const row = (await source.readRows(ctx.ref, 1)).find(
      (r) => r.cells["knit id"]?.value === id,
    )!;
    return {
      status: row.cells.status!.formatted,
      doneOn: row.cells["done on"]!.formatted,
    };
  };

  it("a deleted Knit Note column pauses the tracker at the next pull", async () => {
    await source.deleteColumn(ctx.ref, knitNoteIndex());
    expect(await pull()).toMatchObject({
      outcome: "paused",
      reason: "the Knit Note column is missing",
    });
    expect(await attention()).toEqual([
      { kind: "missing_header", dedupe_key: "missing_header:knit note" },
    ]);
  });

  it("a push that finds the Knit Note column deleted pauses the tracker and holds its write-back, never failing it", async () => {
    const g01 = await taskId("G01");
    await setStatus(g01, "done");
    await source.deleteColumn(ctx.ref, knitNoteIndex());

    expect(await push()).toEqual({
      claimed: 1,
      done: 0,
      retried: 0,
      failed: 0,
    });
    expect(await tracker()).toEqual({
      state: "paused",
      pause_reason: "the Knit Note column is missing",
    });
    expect(await attention()).toEqual([
      { kind: "missing_header", dedupe_key: "missing_header:knit note" },
    ]);
    expect(await push()).toMatchObject({ claimed: 0 });
    expect(
      await db().query("select state::text, attempts from outbox"),
    ).toEqual([{ state: "held", attempts: 0 }]);
    expect(await sheetRow(g01)).toEqual({ status: "Not started", doneOn: "" });

    // The admin restores the column and resumes: the held write-back lands.
    await source.ensureKnitColumns(ctx.ref, 1);
    await db().query("update trackers set state = 'active' where id = $1", [
      ctx.trackerId,
    ]);
    expect(await push()).toMatchObject({ done: 1 });
    expect(await sheetRow(g01)).toEqual({
      status: "Done",
      doneOn: "Mon 28 Sep",
    });
  });

  it("never writes to a column whose cells hold formulas, detected in the sheet (N6)", async () => {
    addFormulas(file, DONE_ON);
    const g01 = await taskId("G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ failed: 1, done: 0 });
    expect(await sheetRow(g01)).toEqual({ status: "Not started", doneOn: "" });
    expect(await attention()).toEqual([
      { kind: "formula_column", dedupe_key: `formula_column:${g01}` },
    ]);
  });

  it("pauses at the next pull when the status column gains formulas after setup (N6)", async () => {
    addFormulas(file, STATUS);
    expect(await pull()).toMatchObject({
      outcome: "paused",
      reason: "column 'Status' holds formulas and cannot be written",
    });
    expect(await attention()).toEqual([
      { kind: "formula_column", dedupe_key: "formula_column:status" },
    ]);
  });

  it("puts the Knit columns after an unlabelled column with data, and the first pull leaves it as it was (11 step 9)", async () => {
    const loose = { ...loadXlsxFile(FIXTURE), id: "loose-copy" };
    // Scratch notes and a helper formula in column M, which has no header.
    loose.tabs[0]!.rows[1]![12] = {
      value: "call Anjan",
      formatted: "call Anjan",
    };
    loose.tabs[0]!.rows[2]![12] = {
      value: null,
      formatted: "",
      formula: '=IF(I3="Done","yes","")',
    };
    const before = structuredClone(
      loose.tabs[0]!.rows.map((row) => row[12] ?? null),
    );
    const looseSource = new MemorySheetSource([loose]);
    const ref: TabRef = { fileId: loose.id, sheetId: 0 };
    await looseSource.ensureKnitColumns(ref, 1);
    const headers = (await looseSource.readStructure(ref, 1)).headers;
    expect(headers.slice(-2).map((h) => [h.letter, h.header])).toEqual([
      ["N", KNIT_ID_HEADER],
      ["O", KNIT_NOTE_HEADER],
    ]);

    const trackerId = await connect(db(), looseSource, loose);
    const [synced] = await store().trackers({ ids: [trackerId] });
    expect(
      await pullTracker({ store: store(), source: looseSource }, synced!, {
        force: true,
      }),
    ).toMatchObject({ outcome: "pulled" });
    expect(loose.tabs[0]!.rows.map((row) => row[12] ?? null)).toEqual(before);
  });
});

describe("the daily structure check (PRD 7.3)", () => {
  const db = useTestDb();
  let file: MemoryFile;
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
  });

  const check = () => structureCheckAll({ store: storeFor(db()), source });
  const attention = () =>
    db().query(
      "select kind, dedupe_key, tracker_id::text from attention_items order by id",
    );

  it("leaves a tracker that still matches alone", async () => {
    expect(await check()).toEqual({
      checked: 1,
      paused: 0,
      failed: 0,
      calendarEnding: false,
    });
    expect(await attention()).toEqual([]);
  });

  it("pauses a tracker whose status column gained formulas, once (N6)", async () => {
    addFormulas(file, STATUS);
    expect(await check()).toMatchObject({ checked: 1, paused: 1 });
    expect(
      await db().query("select state::text, pause_reason from trackers"),
    ).toEqual([
      {
        state: "paused",
        pause_reason: "column 'Status' holds formulas and cannot be written",
      },
    ]);
    // Paused trackers are not checked again; nothing is raised twice.
    expect(await check()).toMatchObject({ checked: 0, paused: 0 });
    expect(await attention()).toEqual([
      {
        kind: "formula_column",
        dedupe_key: "formula_column:status",
        tracker_id: ctx.trackerId,
      },
    ]);
  });

  it("pauses a tracker whose Knit Note column was deleted (D7)", async () => {
    const index = file.tabs[0]!.rows[0]!.findIndex(
      (c) => c?.value === KNIT_NOTE_HEADER,
    );
    await source.deleteColumn(ctx.ref, index);
    expect(await check()).toMatchObject({ paused: 1 });
    expect(await attention()).toEqual([
      {
        kind: "missing_header",
        dedupe_key: "missing_header:knit note",
        tracker_id: ctx.trackerId,
      },
    ]);
  });

  it("pauses a tracker whose tab is gone", async () => {
    const other = await connect(db(), source, file, 5);
    expect(await check()).toMatchObject({ checked: 2, paused: 1 });
    expect(await attention()).toEqual([
      { kind: "missing_header", dedupe_key: "missing_tab", tracker_id: other },
    ]);
  });

  it("raises calendar_ending once when the calendar ends within 60 days (6.2)", async () => {
    await setToday(db(), "2027-11-15");
    expect(await check()).toMatchObject({ calendarEnding: true });
    expect(await check()).toMatchObject({ calendarEnding: true });
    expect(await attention()).toEqual([
      {
        kind: "calendar_ending",
        dedupe_key: "calendar_ending",
        tracker_id: null,
      },
    ]);
  });
});
