import { beforeEach, describe, expect, it } from "vitest";

import type { SheetRow } from "@/lib/domain/rows";
import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";
import { toSheetsSerial } from "@/lib/time";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 10.4, 17 (M5): write-back with verify-after-write, against the real SQL.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const TODAY = "2026-09-28";

async function setup(
  db: Db,
  source: MemorySheetSource,
  file: MemoryFile,
  configOverride: Record<string, unknown> = {},
) {
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
     values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', 'active', $2::jsonb, $3) returning id`,
    [
      file.id,
      JSON.stringify({
        ...fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS),
        ...configOverride,
      }),
      TODAY,
    ],
  );
  const store = storeFor(db);
  const [synced] = await store.trackers({ ids: [tracker!.id] });
  await pullTracker({ store, source }, synced!, { force: true });
  return { me, ref, trackerId: tracker!.id };
}

async function taskId(db: Db, sourceRef: string): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "select id::text from tasks where source_ref = $1",
    [sourceRef],
  );
  return row!.id;
}

async function sheetRow(source: MemorySheetSource, ref: TabRef, id: string) {
  const rows = await source.readRows(ref, 1);
  const row = rows.find((r) => r.cells["knit id"]?.value === id)!;
  return {
    status: row.cells.status!.formatted,
    doneOn: row.cells["done on"]!.formatted,
    note: row.cells["knit note"]!.formatted,
  };
}

describe("push (PRD 10.4)", () => {
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

  const push = () => pushDue({ store: storeFor(db()), source });
  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  /** Starts again on a fresh copy of the tracker; `before` edits the sheet before the first pull. */
  const restart = async (
    configOverride: Record<string, unknown> = {},
    before: (ref: TabRef) => Promise<void> = async () => {},
  ) => {
    file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    await db().query("rollback");
    await db().query("begin");
    await setToday(db(), TODAY);
    await before({ fileId: file.id, sheetId: 0 });
    ctx = await setup(db(), source, file, configOverride);
  };
  const statusOf = async (id: string) =>
    (
      await db().query<{ status: string }>(
        "select status::text from tasks where id = $1",
        [id],
      )
    )[0]!.status;
  const conflicts = () =>
    db().query(
      "select count(*)::int as n from attention_items where kind = 'conflict'",
    );
  const setStatus = (
    id: string,
    status: string,
    reason: string | null = null,
  ) =>
    queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, $2::knit_status, $3)",
      [id, status, reason],
    );

  it("writes a status change to the sheet: status word, Done on text and Knit Note", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toEqual({
      claimed: 1,
      done: 1,
      retried: 0,
      failed: 0,
    });
    expect(await sheetRow(source, ctx.ref, g01)).toEqual({
      status: "Done",
      doneOn: "Mon 28 Sep",
      note: "Done on Mon 28 Sep",
    });
    const [row] = await db().query(
      "select o.state::text, k.source_snapshot from outbox o join tasks k on k.id = o.task_id where o.task_id = $1",
      [g01],
    );
    expect(row).toEqual({
      state: "done",
      source_snapshot: {
        statusKey: "done",
        completedOn: TODAY,
        status: "done",
      },
    });
  });

  it("the next pull does not mistake Knit's own write for a change in the sheet (10.3)", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    await push();
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    const result = await pullTracker({ store, source }, tracker!, {
      force: true,
    });
    expect(result).toMatchObject({ stats: { updated: 0, conflicts: 0 } });
    expect(
      await db().query("select count(*)::int as n from attention_items"),
    ).toEqual([{ n: 0 }]);
  });

  it("clears Done on when the task is changed back, and pushing again changes nothing", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    await push();
    await setStatus(g01, "in_progress");
    await push();
    expect(await sheetRow(source, ctx.ref, g01)).toEqual({
      status: "In progress",
      doneOn: "",
      note: "In progress",
    });
    expect(await push()).toEqual({
      claimed: 0,
      done: 0,
      retried: 0,
      failed: 0,
    });
  });

  it("leaves the status cell alone for a status the tracker cannot express, and says it in the note (N8)", async () => {
    file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    await db().query("rollback");
    await db().query("begin");
    await setToday(db(), TODAY);
    const config = fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS) as {
      writeBack: Record<string, string | null>;
    };
    ctx = await setup(db(), source, file, {
      writeBack: { ...config.writeBack, blocked: null },
    });
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "blocked", "Waiting for T3");
    await push();
    expect(await sheetRow(source, ctx.ref, g01)).toEqual({
      status: "Not started",
      doneOn: "",
      note: "Blocked: Waiting for T3",
    });
  });

  it("fails a write-back whose row is gone with row_not_found", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    await source.deleteRow(ctx.ref, 2);
    expect(await push()).toMatchObject({ failed: 1 });
    const items = await db().query("select kind from attention_items");
    expect(items).toEqual([{ kind: "row_not_found" }]);
  });

  it("never writes to a formula or read-only column (N6)", async () => {
    await db().query(
      `update trackers set config = jsonb_set(config, '{readOnlyColumns}', '["Done on"]') where id = $1`,
      [ctx.trackerId],
    );
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await sheetRow(source, ctx.ref, g01)).toMatchObject({
      status: "Not started",
      doneOn: "",
    });
    expect(await db().query("select kind from attention_items")).toEqual([
      { kind: "formula_column" },
    ]);
  });

  it("holds write-backs of a paused tracker and sends them after it resumes", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    await db().query("update trackers set state = 'paused' where id = $1", [
      ctx.trackerId,
    ]);
    expect(await push()).toMatchObject({ claimed: 0 });
    expect(await db().query("select state::text from outbox")).toEqual([
      { state: "held" },
    ]);
    await db().query("update trackers set state = 'active' where id = $1", [
      ctx.trackerId,
    ]);
    expect(await push()).toMatchObject({ done: 1 });
  });

  it("retries after 1, 2, 5 and 15 minutes, then fails with write_blocked (10.4 step 5)", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    const [{ id }] = (await db().query<{ id: string }>(
      "select id::text from outbox",
    )) as [{ id: string }];
    const store = storeFor(db());
    const waits: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await store.pushResult(id, false, null, "api_error");
      const [row] = await db().query<{ state: string; minutes: number }>(
        "select state::text, round(extract(epoch from next_attempt_at - now()) / 60)::int as minutes from outbox where id = $1",
        [id],
      );
      if (row!.state === "pending") waits.push(row!.minutes);
      else expect(row!.state).toBe("failed");
    }
    expect(waits).toEqual([1, 2, 5, 15]);
    expect(await db().query("select kind from attention_items")).toEqual([
      { kind: "write_blocked" },
    ]);
  });

  it("race: rows sorted between reading and writing: the stray write is undone and retried", async () => {
    class SortBeforeWrite extends MemorySheetSource {
      armed = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (this.armed) {
          this.armed = false;
          // Someone sorts the sheet (reverse order) just before the write lands.
          await this.sortRows(ref, headerRow, () => -1);
        }
        await super.writeCells(ref, headerRow, cells);
      }
    }
    source = new SortBeforeWrite(source.files);
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ retried: 1, done: 0 });
    // No other row kept the misdirected status.
    const rows = await source.readRows(ctx.ref, 1);
    expect(
      rows.filter((r) => r.cells.status?.formatted === "Done"),
    ).toHaveLength(0);
    expect(
      rows.filter((r) => r.cells["knit note"]?.formatted !== ""),
    ).toHaveLength(0);
  });

  it("race: a pasted copy of a task's row (Knit ID included) gets no write; after the next pull the write lands on the task's own row (14)", async () => {
    const g01 = await taskId(db(), "G01");
    const tab = file.tabs[0]!;
    // Someone copies G01's whole row, hidden Knit ID included, and pastes it at the bottom.
    await source.insertRow(
      ctx.ref,
      tab.rows.length + 1,
      tab.rows[1]!.map((cell) => ({ ...cell })),
    );
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ claimed: 1, done: 0, retried: 1 });
    const doneRows = async () =>
      (await source.readRows(ctx.ref, 1))
        .filter((r) => r.cells.status?.formatted === "Done")
        .map((r) => r.rowNumber);
    expect(await doneRows()).toEqual([]);

    // The next pull gives the lower row a new ID; the retry then writes to G01's own row.
    await pull();
    await db().query(
      "update outbox set next_attempt_at = now() where state = 'pending'",
    );
    expect(await push()).toMatchObject({ done: 1 });
    expect(await doneRows()).toEqual([2]);
    expect(await statusOf(g01)).toBe("done");
  });

  it("a note-only write-back never absorbs a status changed in the sheet (N17, 10.3)", async () => {
    const g01 = await taskId(db(), "G01");
    await source.setCell(ctx.ref, 1, 2, "Status", "Done");
    await db().query(
      `insert into outbox (task_id, tracker_id, payload) values ($1, $2, '{"note_only": true}')`,
      [g01, ctx.trackerId],
    );
    expect(await push()).toMatchObject({ done: 1 });
    await pull();
    expect(await statusOf(g01)).toBe("done");
    expect(
      await db().query(
        "select origin::text, new_value from events where task_id = $1 and field = 'status'",
        [g01],
      ),
    ).toEqual([{ origin: "source", new_value: "done" }]);
  });

  it("a status the tracker cannot express (N8) does not absorb a status changed in the sheet (10.3)", async () => {
    const config = fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS) as {
      writeBack: Record<string, string | null>;
    };
    await restart({ writeBack: { ...config.writeBack, blocked: null } });
    const g01 = await taskId(db(), "G01");
    // Someone marks G01 done in the sheet; before the next pull, Knit sets it Blocked.
    await source.setCell(ctx.ref, 1, 2, "Status", "Done");
    await setStatus(g01, "blocked", "Waiting for T3");
    await push(); // writes only the Knit Note (N8)
    const [task] = await db().query<{ source_snapshot: unknown }>(
      "select source_snapshot from tasks where id = $1",
      [g01],
    );
    expect(task!.source_snapshot).toEqual({
      statusKey: "not started",
      completedOn: null,
      status: "yet_to_start",
    });
    // The sheet's Done is a change in the sheet the next pull still sees.
    await pull();
    expect(await statusOf(g01)).toBe("done");
  });

  it("leaves a completed-on value a person typed beside another status alone (10.4 step 4)", async () => {
    await restart({}, async (ref) => {
      await source.setCell(ref, 1, 2, "Status", "In progress");
      await source.setCell(ref, 1, 2, "Done on", "Fri 25 Sep");
    });
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "blocked", "Waiting for T3");
    expect(await push()).toMatchObject({ done: 1 });
    expect(await sheetRow(source, ctx.ref, g01)).toEqual({
      status: "Blocked",
      doneOn: "Fri 25 Sep",
      note: "Blocked: Waiting for T3",
    });
  });

  it("race: a write-back superseded while its push is in flight lands last: the newest is queued again and the pull keeps Knit's status (10.4 step 1)", async () => {
    let reached!: () => void;
    let release!: () => void;
    const atWrite = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    class HeldWrite extends MemorySheetSource {
      held = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (this.held) {
          this.held = false;
          reached();
          await gate; // this push is slow (a 429 backoff, other trackers first)
        }
        await super.writeCells(ref, headerRow, cells);
      }
    }
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "in_progress");
    const slow = pushDue({
      store: storeFor(db()),
      source: new HeldWrite(source.files),
    });
    await atWrite;
    await setStatus(g01, "done"); // supersedes the In progress write-back in flight
    expect(await push()).toMatchObject({ done: 1 });
    release();
    expect(await slow).toMatchObject({ done: 1 });
    expect((await sheetRow(source, ctx.ref, g01)).status).toBe("In progress");

    await pull();
    expect(await statusOf(g01)).toBe("done");
    expect(await conflicts()).toEqual([{ n: 0 }]);
    expect(await push()).toMatchObject({ done: 1 });
    expect(await sheetRow(source, ctx.ref, g01)).toEqual({
      status: "Done",
      doneOn: "Mon 28 Sep",
      note: "Done on Mon 28 Sep",
    });
  });

  it("race: a write-back that lands while a pull reads the rows is never taken for a change in the sheet (10.3, 9.1)", async () => {
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    const store = storeFor(db());
    class PushWhilePullReads extends MemorySheetSource {
      armed = true;
      override async readRows(
        ref: TabRef,
        headerRow: number,
      ): Promise<SheetRow[]> {
        const rows = await super.readRows(ref, headerRow);
        if (this.armed) {
          this.armed = false;
          // The immediate push writes, verifies and records right after the pull read.
          await pushDue({ store, source: this });
        }
        return rows;
      }
    }
    source = new PushWhilePullReads(source.files);
    expect(await pull()).toMatchObject({ outcome: "pulled" });
    expect(await statusOf(g01)).toBe("done");
    expect(
      await db().query(
        "select origin::text from events where task_id = $1 and field = 'status'",
        [g01],
      ),
    ).toEqual([{ origin: "hub" }]);
    expect(await conflicts()).toEqual([{ n: 0 }]);
  });

  /** The sheet takes the write, then cannot be read back for a moment (Google 5xx). */
  class NoReadBack extends MemorySheetSource {
    failReads = 0;
    armed = true;
    override async writeCells(
      ref: TabRef,
      headerRow: number,
      cells: CellWrite[],
    ) {
      await super.writeCells(ref, headerRow, cells);
      if (this.armed) {
        this.armed = false;
        this.failReads = 2;
      }
    }
    override async readRows(
      ref: TabRef,
      headerRow: number,
    ): Promise<SheetRow[]> {
      if (this.failReads > 0) {
        this.failReads -= 1;
        throw new Error("Sheets API 503");
      }
      return super.readRows(ref, headerRow);
    }
  }

  it("a write that cannot be read back is reported with the rows it went to (10.4 step 5, invariant 7)", async () => {
    source = new NoReadBack(source.files);
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ retried: 1, done: 0 });
    expect(
      await db().query("select kind, detail from attention_items"),
    ).toEqual([
      {
        kind: "write_misplaced",
        detail: { reason: "unverified", rows: [2] },
      },
    ]);
  });

  it("a pull between a push's write and its result raises no conflict: the sheet already says what Knit says (10.3, 15)", async () => {
    const sheet = new NoReadBack(source.files);
    source = sheet;
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ retried: 1 });
    sheet.failReads = 0; // the sheet reads fine again when the pull runs
    expect(await pull()).toMatchObject({ stats: { conflicts: 0 } });
    expect(await conflicts()).toEqual([{ n: 0 }]);

    await db().query(
      "update outbox set next_attempt_at = now() where state = 'pending'",
    );
    expect(await push()).toMatchObject({ done: 1 });
    const [task] = await db().query<{ source_snapshot: unknown }>(
      "select source_snapshot from tasks where id = $1",
      [g01],
    );
    expect(task!.source_snapshot).toEqual({
      statusKey: "done",
      completedOn: TODAY,
      status: "done",
    });
    expect(await conflicts()).toEqual([{ n: 0 }]);
  });

  it("race: a write that lands on a row without a Knit ID is reported, never 'undone' with another row's values", async () => {
    // A row added since the last pull (no Knit ID yet), marked Blocked.
    await source.setCell(ctx.ref, 1, 36, "Task", "Added after the pull");
    await source.setCell(ctx.ref, 1, 36, "Status", "Blocked");
    class InsertBeforeWrite extends MemorySheetSource {
      armed = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (this.armed) {
          this.armed = false;
          await this.insertRow(ref, 2, []); // a new row at the top as the write goes out
        }
        await super.writeCells(ref, headerRow, cells);
      }
    }
    source = new InsertBeforeWrite(source.files);
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ retried: 1, done: 0 });
    const rows = await source.readRows(ctx.ref, 1);
    const landed = rows.find((r) => r.rowNumber === 2)!;
    expect(landed.cells.status?.formatted).toBe("Done");
    expect(
      await db().query("select kind, detail from attention_items"),
    ).toEqual([
      {
        kind: "write_misplaced",
        detail: {
          reason: "stray_write",
          row: 2,
          headers: ["Status", "Done on", "Knit Note"],
        },
      },
    ]);
  });

  it("race: a write undone on another task's row puts its date back as a date", async () => {
    await restart({ completedOnFormat: { type: "date" } });
    const serial = toSheetsSerial("2026-09-25");
    await source.setCell(ctx.ref, 1, 3, "Done on", serial); // G02 already has a real date
    class SwapBeforeWrite extends MemorySheetSource {
      armed = true;
      override async writeCells(
        ref: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (this.armed) {
          this.armed = false;
          // Someone swaps rows 2 and 3 just before the write lands.
          const rows = this.tab(ref).rows;
          [rows[1], rows[2]] = [rows[2]!, rows[1]!];
        }
        await super.writeCells(ref, headerRow, cells);
      }
    }
    source = new SwapBeforeWrite(source.files);
    const g01 = await taskId(db(), "G01");
    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ retried: 1 });
    const g02 = (await source.readRows(ctx.ref, 1)).find(
      (r) => r.cells.id?.formatted === "G02",
    )!;
    expect(g02.rowNumber).toBe(2);
    expect(g02.cells["done on"]!.value).toBe(serial);
    expect(g02.cells.status!.formatted).toBe("Not started");
    expect(g02.cells["knit note"]!.formatted).toBe("");
  });
});
