import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { discover } from "@/lib/sync/discover";
import { pullTracker } from "@/lib/sync/pull";
import type { SyncStore, SyncTracker } from "@/lib/sync/store";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 10.1, 10.2, 17 (M4): the pull job end to end on a writable copy of the Filing Buddy
// Google Ads tracker, against the real SQL.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const TODAY = "2026-09-28";

async function setup(db: Db, source: MemorySheetSource, file: MemoryFile) {
  const admin = await createUser(db, { role: "admin", name: "Pragaman" });
  await db.query(
    "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
    [admin],
  );
  const ref: TabRef = { fileId: file.id, sheetId: 0 };
  await source.ensureKnitColumns(ref, 1);
  await db.query(
    `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
    [file.id, file.name],
  );
  const [tracker] = await db.query<{ id: string }>(
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, owner_user_id, state, config, go_live_date)
     values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', $2, 'active', $3::jsonb, $4)
     returning id`,
    [
      file.id,
      admin,
      JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
      TODAY,
    ],
  );
  return { admin, ref, trackerId: tracker!.id };
}

async function trackerRow(db: Db, id: string): Promise<SyncTracker> {
  const [t] = await storeFor(db).trackers({
    states: ["active", "paused"],
    ids: [id],
  });
  return t!;
}

/** Everything a pull can change, for "second pull changes nothing". */
async function snapshot(db: Db, trackerId: string) {
  return db.query(
    `select
       (select jsonb_agg(to_jsonb(k) - 'updated_at' - 'source_synced_at' order by id) from tasks k where tracker_id = $1) as tasks,
       (select jsonb_agg(to_jsonb(d) order by d.id) from task_days d join tasks k on k.id = d.task_id where k.tracker_id = $1) as days,
       (select count(*)::int from events where tracker_id = $1) as events,
       (select count(*)::int from outbox where tracker_id = $1) as outbox,
       (select count(*)::int from attention_items where tracker_id = $1) as attention`,
    [trackerId],
  );
}

describe("pull (PRD 10.2)", () => {
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

  const pull = async (force = true) =>
    pullTracker(
      { store: storeFor(db()), source },
      await trackerRow(db(), ctx.trackerId),
      { force },
    );

  it("imports the tracker, writes Knit IDs, and a second pull changes nothing", async () => {
    const first = await pull();
    expect(first).toMatchObject({
      outcome: "pulled",
      idsWritten: 34,
      stats: { rows: 34, inserted: 34 },
    });

    const ids = await source.readColumn(ctx.ref, 1, "Knit ID");
    expect(ids.filter((c) => /^[0-9a-f-]{36}$/.test(c.value))).toHaveLength(34);
    const [counts] = await db().query(
      `select count(*)::int as tasks,
              (select count(*)::int from task_days) as days,
              (select count(*)::int from task_assignees) as assigned
       from tasks`,
    );
    // 32 single dates and 1 window get a task-day; "From 30 Oct" is open-ended (N9).
    expect(counts).toEqual({ tasks: 34, days: 33, assigned: 34 });

    const before = await snapshot(db(), ctx.trackerId);
    const second = await pull();
    expect(second).toMatchObject({
      outcome: "pulled",
      idsWritten: 0,
      stats: { inserted: 0, updated: 0, removed: 0 },
    });
    expect(await snapshot(db(), ctx.trackerId)).toEqual(before);
  });

  it("skips a sheet that has not changed since the last pull", async () => {
    await pull();
    // The first pull wrote IDs, so the sheet changed once more; after that it is quiet.
    await pull(false);
    expect(await pull(false)).toMatchObject({ outcome: "skipped" });
  });

  it("brings a status changed in the sheet into Knit (6.6)", async () => {
    await pull();
    await source.setCell(ctx.ref, 1, 2, "Status", "Done");
    await pull();
    const [task] = await db().query(
      `select k.status::text, k.completed_on::text, d.status::text as day_status
       from tasks k join task_days d on d.task_id = k.id where k.source_ref = 'G01'`,
    );
    expect(task).toEqual({
      status: "done",
      completed_on: TODAY,
      day_status: "done",
    });
    const events = await db().query(
      "select origin::text from events where field = 'status'",
    );
    expect(events).toEqual([{ origin: "source" }]);
  });

  it("cancels the open task-days of a row deleted from the sheet (6.6)", async () => {
    await pull();
    await source.deleteRow(ctx.ref, 2);
    await pull();
    const [task] = await db().query(
      `select k.removed_at_source is not null as removed, d.status::text, d.reason
       from tasks k join task_days d on d.task_id = k.id where k.source_ref = 'G01'`,
    );
    expect(task).toEqual({
      removed: true,
      status: "cancelled",
      reason: "Removed at source",
    });
  });

  it("does not care when rows are sorted (invariant 3)", async () => {
    await pull();
    const before = await snapshot(db(), ctx.trackerId);
    await source.sortRows(ctx.ref, 1, (a, b) =>
      String(b[3]?.value).localeCompare(String(a[3]?.value)),
    );
    const after = await pull();
    expect(after).toMatchObject({ stats: { inserted: 0, removed: 0 } });
    const rows = await snapshot(db(), ctx.trackerId);
    // Only the row hints moved.
    const strip = (s: typeof before) =>
      JSON.stringify(s[0]).replace(/"row_hint":\d+/g, "");
    expect(strip(rows)).toEqual(strip(before));
  });

  it("race: a row inserted between writing IDs and checking them clears those IDs until the next pull", async () => {
    class InsertDuringWrite extends MemorySheetSource {
      armed = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        await super.writeCells(ref, headerRow, cells);
        if (this.armed && cells.some((c) => c.value !== "")) {
          this.armed = false;
          await this.insertRow(ref, 2, []); // someone inserts a row at the top
        }
      }
    }
    source = new InsertDuringWrite([file]);
    const first = await pull();
    expect(first).toMatchObject({
      outcome: "pulled",
      idsWritten: 34,
      idsCleared: 34,
      stats: { inserted: 0 },
    });
    expect(
      (await source.readColumn(ctx.ref, 1, "Knit ID")).every(
        (c) => c.value === "",
      ),
    ).toBe(true);

    const second = await pull();
    expect(second).toMatchObject({
      idsWritten: 34,
      idsCleared: 0,
      stats: { inserted: 34 },
    });
  });

  it("race: a pasted duplicate Knit ID gives the lower row a new ID and raises an item", async () => {
    await pull();
    const [first] = await source.readColumn(ctx.ref, 1, "Knit ID");
    await source.setCell(ctx.ref, 1, 3, "Knit ID", first!.value);
    const result = await pull();
    expect(result).toMatchObject({ idsWritten: 1 });
    const ids = (await source.readColumn(ctx.ref, 1, "Knit ID")).map(
      (c) => c.value,
    );
    expect(new Set(ids).size).toBe(ids.length);
    const items = await db().query(
      "select kind from attention_items where kind = 'duplicate_knit_id'",
    );
    expect(items).toHaveLength(1);
  });

  /** A row added at the bottom since the last pull, so the next pull writes its Knit ID. */
  async function addNewRow(row: number) {
    const cells = [
      ["ID", "G35"],
      ["Date", "Tue 29 Sep"],
      ["Task", "A task added after go-live"],
      ["Owner", "Pragaman"],
      ["Status", "Not started"],
    ] as const;
    for (const [header, value] of cells)
      await source.setCell(ctx.ref, 1, row, header, value);
  }

  /** Runs `edit` as a person would, just before the first Knit ID write reaches the sheet. */
  function editBeforeIdWrite(
    edit: (sheet: MemorySheetSource) => Promise<void>,
  ) {
    return class extends MemorySheetSource {
      armed = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (
          this.armed &&
          cells.some((c) => c.header === "Knit ID" && c.value !== "")
        ) {
          this.armed = false;
          await edit(this);
        }
        await super.writeCells(ref, headerRow, cells);
      }
    };
  }

  const removedCount = () =>
    db().query(
      "select count(*)::int as n from tasks where removed_at_source is not null",
    );

  it("race: a row inserted just before a Knit ID write lands: the Knit ID it hit is put back and nothing is removed (10.2 step 4, 14)", async () => {
    await pull();
    await addNewRow(36);
    const [g34] = await db().query<{ id: string }>(
      "select id::text from tasks where source_ref = 'G34'",
    );
    // Someone inserts a row at the top as the write goes out: G34 moves into row 36, where
    // Knit writes the new row's ID.
    const Sheet = editBeforeIdWrite((sheet) => sheet.insertRow(ctx.ref, 2, []));
    source = new Sheet([file]);
    expect(await pull()).toMatchObject({
      outcome: "pulled",
      idsWritten: 1,
      idsCleared: 0,
      stats: { inserted: 0, removed: 0 },
    });
    const rows = await source.readRows(ctx.ref, 1);
    const knitIdOf = (ref: string) =>
      rows.find((r) => r.cells.id?.formatted === ref)?.cells["knit id"]
        ?.formatted;
    expect(knitIdOf("G34")).toBe(g34!.id);
    expect(knitIdOf("G35")).toBe("");
    expect(await removedCount()).toEqual([{ n: 0 }]);

    // The new row gets its ID on the next pull.
    expect(await pull()).toMatchObject({
      idsWritten: 1,
      stats: { inserted: 1, removed: 0 },
    });
  });

  it("race: when the Knit ID a write hit cannot be put back, the pull applies nothing and says so (invariant 7)", async () => {
    await pull();
    await addNewRow(36);
    // A row is inserted at the top and G34 (now in row 36) is renamed at the same moment.
    const Sheet = editBeforeIdWrite(async (sheet) => {
      await sheet.insertRow(ctx.ref, 2, []);
      await sheet.setCell(ctx.ref, 1, 36, "Task", "Offline conversions (v2)");
    });
    source = new Sheet([file]);
    expect(await pull()).toMatchObject({ outcome: "stale" });
    expect(await removedCount()).toEqual([{ n: 0 }]);
    const items = await db().query(
      "select kind, detail ->> 'reason' as reason from attention_items",
    );
    expect(items).toEqual([
      { kind: "write_misplaced", reason: "knit_id_lost" },
    ]);
  });

  it("a Knit ID typed again in capitals is still the same ID (invariant 3)", async () => {
    await pull();
    const [first] = await source.readColumn(ctx.ref, 1, "Knit ID");
    await source.setCell(ctx.ref, 1, 2, "Knit ID", first!.value.toUpperCase());
    expect(await pull()).toMatchObject({
      outcome: "pulled",
      idsWritten: 0,
      stats: { inserted: 0, removed: 0 },
    });
    expect(await removedCount()).toEqual([{ n: 0 }]);
  });

  it("picks up a renamed tab's new name and keeps syncing it (7.4, 14)", async () => {
    await pull();
    file.tabs[0]!.title = "Q4 Tasks";
    expect(await pull()).toMatchObject({ outcome: "pulled" });
    const [tracker] = await db().query(
      "select tab_name from trackers where id = $1",
      [ctx.trackerId],
    );
    expect(tracker).toEqual({ tab_name: "Q4 Tasks" });
  });

  it("pauses the tracker when a mapped column is renamed, and says which (10.2 step 2, 14)", async () => {
    await pull();
    await source.setCell(ctx.ref, 1, 1, "Status", "State");
    expect(await pull()).toMatchObject({
      outcome: "paused",
      reason: "column 'Status' not found",
    });
    const [tracker] = await db().query(
      "select state::text, pause_reason from trackers where id = $1",
      [ctx.trackerId],
    );
    expect(tracker).toEqual({
      state: "paused",
      pause_reason: "column 'Status' not found",
    });
    const items = await db().query(
      "select kind, dedupe_key from attention_items",
    );
    expect(items).toEqual([
      { kind: "missing_header", dedupe_key: "missing_header:status" },
    ]);
  });

  it("pauses when the Knit ID column is gone", async () => {
    await pull();
    await source.setCell(ctx.ref, 1, 1, "Knit ID", null);
    expect(await pull()).toMatchObject({
      outcome: "paused",
      reason: "the Knit ID column is missing",
    });
  });

  it("race: a plan loaded before the close of D is planned again after it, so the sheet's Done lands on the spillover (9.1, 10.2 step 7)", async () => {
    await pull();
    const [g02] = await db().query<{ id: string; due: string }>(
      "select id::text, due_date::text as due from tasks where source_ref = 'G02'",
    );
    expect(g02!.due).toBe(TODAY);
    const row = (await source.readRows(ctx.ref, 1)).find(
      (r) => r.cells.id?.formatted === "G02",
    )!.rowNumber;

    // After midnight, before 28 Sep is closed, G02 is marked Done in the sheet. A pull loads
    // Knit's state and reads the sheet; the close of 28 Sep commits before its plan is applied.
    await setToday(db(), "2026-09-29");
    await source.setCell(ctx.ref, 1, row, "Status", "Done");
    const store = storeFor(db());
    let closed = false;
    const racing: SyncStore = {
      ...store,
      async applyPullPlan(...args) {
        if (!closed) {
          closed = true;
          await store.closeDay(TODAY);
        }
        return store.applyPullPlan(...args);
      },
    };
    expect(
      await pullTracker(
        { store: racing, source },
        await trackerRow(db(), ctx.trackerId),
        { force: true },
      ),
    ).toMatchObject({ outcome: "pulled" });
    expect(closed).toBe(true);

    const [task] = await db().query(
      "select status::text, completed_on::text from tasks where id = $1",
      [g02!.id],
    );
    expect(task).toEqual({ status: "done", completed_on: "2026-09-29" });
    expect(
      (await taskDays(db(), g02!.id)).map((d) => [d.day, d.status, d.locked]),
    ).toEqual([
      [TODAY, "not_done", true],
      ["2026-09-29", "done", false],
    ]);
  });

  describe("a row that comes back after its task was removed at source (N30, N59)", () => {
    const UUID = /^[0-9a-f-]{36}$/;

    /** Takes the row of `sourceRef` out of the sheet; `putBack` restores it, maybe edited. */
    async function deleteRow(sourceRef: string) {
      const tab = file.tabs[0]!;
      const index = tab.rows.findIndex((cells) =>
        cells.some((c) => c.formatted === sourceRef),
      );
      const saved = tab.rows[index]!.map((cell) => ({ ...cell }));
      const headers = tab.rows[0]!.map((c) => c.formatted);
      await source.deleteRow(ctx.ref, index + 1);
      return {
        putBack: async (edits: Record<string, string> = {}) => {
          const cells = saved.map((cell) => ({ ...cell }));
          for (const [header, value] of Object.entries(edits))
            cells[headers.indexOf(header)] = { value, formatted: value };
          await source.insertRow(ctx.ref, index + 1, cells);
        },
      };
    }

    const taskOf = async (sourceRef: string) =>
      db().query<{ id: string; removed: boolean }>(
        `select id::text, removed_at_source is not null as removed from tasks
         where source_ref = $1 order by removed_at_source nulls first`,
        [sourceRef],
      );
    const knitIdInSheet = async (sourceRef: string) =>
      (await source.readRows(ctx.ref, 1)).find(
        (r) => r.cells.id?.formatted === sourceRef,
      )?.cells["knit id"]?.formatted;
    const lastPullStats = async () =>
      (
        await db().query<{ ok: boolean; stats: Record<string, unknown> }>(
          "select ok, stats from sync_runs where job = 'pull' order by id desc limit 1",
        )
      )[0]!;
    const outboxOf = (taskId: string) =>
      db().query(
        "select state::text, payload from outbox where task_id = $1 order by id",
        [taskId],
      );
    const days = async (taskId: string) =>
      (await taskDays(db(), taskId)).map((d) => [
        d.day,
        d.status,
        d.spill_index,
        d.origin,
        d.locked,
      ]);

    it("after the close of its removal: a new task with a new Knit ID; the old one stays removed with its locked task-day", async () => {
      await pull();
      const [old] = await taskOf("G31");
      const row = await deleteRow("G31");
      await pull();
      expect(await taskOf("G31")).toEqual([{ id: old!.id, removed: true }]);
      expect(await days(old!.id)).toEqual([
        ["2026-10-05", "cancelled", 0, "planned", false],
      ]);
      await setToday(db(), "2026-09-29");
      await storeFor(db()).closeDay(TODAY);

      await row.putBack();
      const back = await pull();
      expect(back).toMatchObject({
        outcome: "pulled",
        idsWritten: 1,
        stats: { inserted: 1, removed: 0 },
      });
      const fresh = await knitIdInSheet("G31");
      expect(fresh).toMatch(UUID);
      expect(fresh).not.toBe(old!.id);
      expect(await taskOf("G31")).toEqual([
        { id: fresh, removed: false },
        { id: old!.id, removed: true },
      ]);
      const [task] = await db().query(
        "select status::text, history_only, due_date::text as due from tasks where id = $1",
        [fresh],
      );
      expect(task).toEqual({
        status: "yet_to_start",
        history_only: false,
        due: "2026-10-05",
      });
      expect(await days(fresh!)).toEqual([
        ["2026-10-05", "yet_to_start", 0, "planned", false],
      ]);
      expect(await days(old!.id)).toEqual([
        ["2026-10-05", "cancelled", 0, "planned", true],
      ]);
      expect((await lastPullStats()).stats).toMatchObject({
        inserted: 1,
        removed: 0,
        rowsReturned: 1,
      });
      expect(
        await db().query(
          `select kind from attention_items
           where kind = 'duplicate_knit_id' or detail ->> 'reason' = 'restored_after_close'`,
        ),
      ).toEqual([]);
      // N59: the Knit Note still describes the removed task, so a note-only write-back is queued.
      expect(await outboxOf(fresh!)).toEqual([
        { state: "pending", payload: { note_only: true } },
      ]);
    });

    it("back before the close: the old task-day is locked cancelled by the close, the new task's is untouched", async () => {
      await pull();
      const [old] = await taskOf("G31");
      const row = await deleteRow("G31");
      await pull();
      await row.putBack();
      await pull();
      const fresh = await knitIdInSheet("G31");
      expect(fresh).not.toBe(old!.id);

      await setToday(db(), "2026-09-29");
      await storeFor(db()).closeDay(TODAY);
      expect(await days(old!.id)).toEqual([
        ["2026-10-05", "cancelled", 0, "planned", true],
      ]);
      expect(await days(fresh!)).toEqual([
        ["2026-10-05", "yet_to_start", 0, "planned", false],
      ]);
    });

    it("with a due date already past: the new task is a spillover on today with past_date_added", async () => {
      await pull();
      const row = await deleteRow("G02");
      await pull();
      await setToday(db(), "2026-09-29");
      await storeFor(db()).closeDay(TODAY);
      await row.putBack();
      await pull();
      const fresh = await knitIdInSheet("G02");
      expect(await days(fresh!)).toEqual([
        ["2026-09-29", "yet_to_start", 1, "spillover", false],
      ]);
      expect(
        await db().query(
          "select kind from attention_items where task_id = $1",
          [fresh],
        ),
      ).toEqual([{ kind: "past_date_added" }]);
    });

    it("dated before go-live: the new task is history only, and backlog review lists it (6.11)", async () => {
      await pull();
      const row = await deleteRow("G31");
      await pull();
      await row.putBack({ Date: "Fri 25 Sep" });
      await pull();
      const fresh = await knitIdInSheet("G31");
      const [task] = await db().query(
        "select history_only from tasks where id = $1",
        [fresh],
      );
      expect(task).toEqual({ history_only: true });
      expect(await days(fresh!)).toEqual([]);
      const [backlog] = await queryAs<{ v: unknown }>(
        db(),
        { kind: "user", id: ctx.admin },
        "select admin_backlog($1) as v",
        [ctx.trackerId],
      );
      expect(JSON.stringify(backlog!.v)).toContain(fresh);
    });

    it("showing Done in the sheet: the new task is done, completed today, with no spillover", async () => {
      await pull();
      const row = await deleteRow("G02");
      await pull();
      await setToday(db(), "2026-09-29");
      await storeFor(db()).closeDay(TODAY);
      await row.putBack({ Status: "Done" });
      await pull();
      const fresh = await knitIdInSheet("G02");
      const [task] = await db().query(
        "select status::text, completed_on::text from tasks where id = $1",
        [fresh],
      );
      expect(task).toEqual({ status: "done", completed_on: "2026-09-29" });
      expect(await days(fresh!)).toEqual([]);
      expect(
        await db().query(
          "select kind from attention_items where task_id = $1",
          [fresh],
        ),
      ).toEqual([]);
    });

    it("deleted and put back between two pulls: the same task, and its Knit ID stays", async () => {
      await pull();
      const [old] = await taskOf("G31");
      const row = await deleteRow("G31");
      await row.putBack();
      expect(await pull()).toMatchObject({
        idsWritten: 0,
        stats: { inserted: 0, removed: 0 },
      });
      expect(await taskOf("G31")).toEqual([{ id: old!.id, removed: false }]);
      expect(await knitIdInSheet("G31")).toBe(old!.id);
      expect((await lastPullStats()).stats).toMatchObject({ rowsReturned: 0 });
    });

    it("pulling again after the return changes nothing (invariant 8)", async () => {
      await pull();
      const row = await deleteRow("G31");
      await pull();
      await row.putBack();
      await pull();
      const before = await snapshot(db(), ctx.trackerId);
      expect(await pull()).toMatchObject({
        idsWritten: 0,
        stats: { inserted: 0, removed: 0 },
      });
      expect((await lastPullStats()).stats).toMatchObject({ rowsReturned: 0 });
      expect(await snapshot(db(), ctx.trackerId)).toEqual(before);
    });

    it("apply answers retry once: the new ID is written once, the task made once, and the note refresh still queued", async () => {
      await pull();
      const row = await deleteRow("G31");
      await pull();
      await row.putBack();
      const store = storeFor(db());
      let bumped = false;
      const racing: SyncStore = {
        ...store,
        async applyPullPlan(...args) {
          if (!bumped) {
            bumped = true;
            // A change made in Knit meanwhile moves state_version (9.1).
            await db().query(
              "update trackers set state_version = state_version + 1 where id = $1",
              [ctx.trackerId],
            );
          }
          return store.applyPullPlan(...args);
        },
      };
      expect(
        await pullTracker(
          { store: racing, source },
          await trackerRow(db(), ctx.trackerId),
          { force: true },
        ),
      ).toMatchObject({
        outcome: "pulled",
        idsWritten: 1,
        stats: { inserted: 1 },
      });
      expect(bumped).toBe(true);
      const fresh = await knitIdInSheet("G31");
      expect(await taskOf("G31")).toHaveLength(2);
      expect(await outboxOf(fresh!)).toEqual([
        { state: "pending", payload: { note_only: true } },
      ]);
      expect((await lastPullStats()).stats).toMatchObject({ rowsReturned: 1 });
    });

    it("a note refresh that fails never fails the pull: the run is recorded ok and the failure logged", async () => {
      await pull();
      const row = await deleteRow("G31");
      await pull();
      await row.putBack();
      const store = storeFor(db());
      const failing: SyncStore = {
        ...store,
        enqueueNoteRefresh: () => Promise.reject(new Error("db down")),
      };
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(
          await pullTracker(
            { store: failing, source },
            await trackerRow(db(), ctx.trackerId),
            { force: true },
          ),
        ).toMatchObject({ outcome: "pulled", stats: { inserted: 1 } });
        expect(
          log.mock.calls.some(([line]) =>
            String(line).includes('"event":"pull.note_refresh_failed"'),
          ),
        ).toBe(true);
      } finally {
        log.mockRestore();
      }
      expect(await lastPullStats()).toMatchObject({
        ok: true,
        stats: { rowsReturned: 1 },
      });
      const fresh = await knitIdInSheet("G31");
      expect(await taskOf("G31")).toContainEqual({
        id: fresh,
        removed: false,
      });
      expect(await outboxOf(fresh!)).toEqual([]);
    });
  });

  it("apply_pull_plan answers retry on a stale state_version and applies nothing (17)", async () => {
    const store = storeFor(db());
    const plan = {
      trackerId: ctx.trackerId,
      today: TODAY,
      taskInserts: [],
      taskUpdates: [],
      taskDayInserts: [],
      taskDayUpdates: [],
      assigneeSets: [],
      removals: [],
      outbox: [],
      attention: [
        {
          kind: "conflict" as const,
          dedupeKey: "conflict:x",
          taskId: null,
          detail: {},
        },
      ],
      events: [],
      stats: {
        rows: 0,
        inserted: 0,
        updated: 0,
        removed: 0,
        skipped: 0,
        conflicts: 0,
      },
    };
    expect(
      await store.applyPullPlan(ctx.trackerId, 99, plan, null, null),
    ).toEqual({ result: "retry" });
    expect(
      await store.applyPullPlan(
        ctx.trackerId,
        0,
        { ...plan, today: "2026-09-27" },
        null,
        null,
      ),
    ).toEqual({
      result: "retry",
    });
    expect(
      await db().query("select count(*)::int as n from attention_items"),
    ).toEqual([{ n: 0 }]);
  });
});

describe("discover (PRD 10.1)", () => {
  const db = useTestDb();

  it("records new sheets, other files, and pauses trackers whose sheet left the folder", async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(FIXTURE);
    const source = new MemorySheetSource([file]);
    const { trackerId } = await setup(db(), source, file);
    const store = storeFor(db());

    const xlsx: MemoryFile = {
      ...file,
      id: "uploaded.xlsx",
      name: "Uploaded",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      tabs: [],
    };
    const other: MemoryFile = { ...file, id: "new-sheet", name: "New tracker" };
    source.files.push(xlsx, other);
    expect(await discover({ store, source })).toMatchObject({
      listed: 3,
      new: 2,
      left: 0,
    });
    const states = await db().query(
      "select file_id, state::text from drive_files order by file_id",
    );
    expect(states).toEqual([
      { file_id: file.id, state: "connected" },
      { file_id: "new-sheet", state: "new" },
      { file_id: "uploaded.xlsx", state: "not_a_sheet" },
    ]);

    source.files.splice(0, 1); // the tracker's sheet moved out of the folder
    expect(await discover({ store, source })).toMatchObject({
      left: 1,
      paused: 1,
    });
    const [tracker] = await db().query(
      "select state::text, pause_reason from trackers where id = $1",
      [trackerId],
    );
    expect(tracker).toEqual({
      state: "paused",
      pause_reason: "Left the Knit folder",
    });
  });
});
