import { beforeEach, describe, expect, it } from "vitest";

import type { SheetRow } from "@/lib/domain/rows";
import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { mismatchCheck } from "@/lib/sync/close";
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

  describe("write-backs of a task removed at source (N11, N30, N59)", () => {
    /** Takes G01's row out of the sheet; `putBack` restores it as it was. */
    function takeG01() {
      const tab = file.tabs[0]!;
      const saved = tab.rows[1]!.map((cell) => ({ ...cell }));
      return {
        remove: () => source.deleteRow(ctx.ref, 2),
        putBack: () =>
          source.insertRow(
            ctx.ref,
            2,
            saved.map((cell) => ({ ...cell })),
          ),
      };
    }
    const cells = () => JSON.stringify(file.tabs[0]!.rows);
    const rowNotFound = () =>
      db().query(
        "select kind, state from attention_items where kind = 'row_not_found' order by id",
      );
    const outboxOf = (id: string) =>
      db().query(
        "select state::text, last_error from outbox where task_id = $1 order by id",
        [id],
      );

    it("a pending write-back of a task then removed fails with row_not_found, and the row put back is never written", async () => {
      const g01 = await taskId(db(), "G01");
      await setStatus(g01, "done");
      const row = takeG01();
      await row.remove();
      await pull();
      await row.putBack();
      const before = cells();
      expect(await push()).toMatchObject({ claimed: 1, failed: 1, done: 0 });
      expect(cells()).toBe(before);
      expect(await rowNotFound()).toEqual([
        { kind: "row_not_found", state: "open" },
      ]);
      expect(await outboxOf(g01)).toEqual([
        { state: "failed", last_error: "row_not_found" },
      ]);
    });

    it("a correction on a removed task's locked task-day fails with row_not_found, again after Retry", async () => {
      const admin = await createUser(db(), { role: "admin", name: "Admin" });
      const g01 = await taskId(db(), "G01");
      const row = takeG01();
      await row.remove();
      await pull();
      await setToday(db(), "2026-09-29");
      await storeFor(db()).closeDay(TODAY);
      await push(); // the Knit Note refreshes the close queued for the other tasks
      const [day] = await db().query<{ id: string }>(
        "select id::text from task_days where task_id = $1 and locked",
        [g01],
      );
      await queryAs(
        db(),
        { kind: "user", id: admin },
        "select admin_correct_task_day($1::bigint, 'done', 'Was done on Monday')",
        [day!.id],
      );
      await row.putBack();
      const before = cells();
      expect(await push()).toMatchObject({ claimed: 1, failed: 1 });
      expect(cells()).toBe(before);

      await queryAs(
        db(),
        { kind: "user", id: admin },
        "select admin_retry_writes()",
      );
      expect(await push()).toMatchObject({ claimed: 1, failed: 1 });
      expect(cells()).toBe(before);
      // Retry resolved the first item; the failed retry raised one open item again.
      expect(await rowNotFound()).toEqual([
        { kind: "row_not_found", state: "resolved" },
        { kind: "row_not_found", state: "open" },
      ]);
    });

    it("a task a pull marks removed after the claim is not written, though its row is still there (N59)", async () => {
      const g01 = await taskId(db(), "G01");
      await setStatus(g01, "done");
      const store = storeFor(db());
      const racing = {
        ...store,
        // A pull beside this push (its own lease) marks the task removed once it is claimed;
        // the row is back in the sheet before the push reads it.
        async pushClaim(limit: number, task: string | null) {
          const claimed = await store.pushClaim(limit, task);
          await db().query(
            "update tasks set removed_at_source = now() where id = $1",
            [g01],
          );
          return claimed;
        },
      };
      const before = cells();
      expect(await pushDue({ store: racing, source })).toMatchObject({
        claimed: 1,
        failed: 1,
        done: 0,
      });
      expect(cells()).toBe(before);
      expect(await outboxOf(g01)).toEqual([
        { state: "failed", last_error: "row_not_found" },
      ]);
    });

    it("push_claim says whether each task was removed at source, and a status write-back still beats a note-only one (N17)", async () => {
      const g01 = await taskId(db(), "G01");
      const g02 = await taskId(db(), "G02");
      await db().query(
        `insert into outbox (task_id, tracker_id, payload) values
           ($1, $3, '{"status_value": "Done", "completed_on": "2026-09-28"}'),
           ($1, $3, '{"note_only": true}'),
           ($2, $3, '{"note_only": true}')`,
        [g01, g02, ctx.trackerId],
      );
      await db().query(
        "update tasks set removed_at_source = now() where id = $1",
        [g02],
      );
      const claimed = (await storeFor(db()).pushClaim(200, null)) as {
        payload: Record<string, unknown>;
        task: { id: string; removedAtSource: boolean };
      }[];
      expect(
        claimed.map((c) => [c.task.id, c.task.removedAtSource, c.payload]),
      ).toEqual([
        [g01, false, { status_value: "Done", completed_on: "2026-09-28" }],
        [g02, true, { note_only: true }],
      ]);
    });
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

  it("a pasted copy never fails for good: duplicate_knit_id keeps retrying with the normal backoff (N22, 10.4 step 5)", async () => {
    const g01 = await taskId(db(), "G01");
    const tab = file.tabs[0]!;
    await source.insertRow(
      ctx.ref,
      tab.rows.length + 1,
      tab.rows[1]!.map((cell) => ({ ...cell })),
    );
    await setStatus(g01, "done");
    const [{ id }] = (await db().query<{ id: string }>(
      "select id::text from outbox",
    )) as [{ id: string }];
    const store = storeFor(db());
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      await store.pushResult(id, false, null, "duplicate_knit_id");
      const [row] = await db().query<{ state: string; minutes: number }>(
        "select state::text, round(extract(epoch from next_attempt_at - now()) / 60)::int as minutes from outbox where id = $1",
        [id],
      );
      expect(row!.state).toBe("pending");
      waits.push(row!.minutes);
    }
    expect(waits).toEqual([1, 2, 5, 15, 60, 60]);

    // The push counts it as a retry, whatever the attempts so far.
    await db().query(
      "update outbox set next_attempt_at = now() where id = $1",
      [id],
    );
    expect(await push()).toEqual({
      claimed: 1,
      done: 0,
      retried: 1,
      failed: 0,
    });
    expect(
      await db().query("select state::text, attempts from outbox"),
    ).toEqual([{ state: "pending", attempts: 7 }]);
    expect(await db().query("select kind from attention_items")).toEqual([]);
  });

  it("a Knit ID left on a row whose cells were cleared does not block the write, nor the mismatch check (10.2 step 3, N22)", async () => {
    const g01 = await taskId(db(), "G01");
    const tab = file.tabs[0]!;
    // Someone copies G01's whole row (hidden Knit ID included) to the top, then clears the
    // visible cells of the old row, now row 3. Its Knit ID stays.
    await source.insertRow(
      ctx.ref,
      2,
      tab.rows[1]!.map((cell) => ({ ...cell })),
    );
    const idColumn = source
      .headers(tab, 1)
      .find((h) => h.normalised === "knit id")!.index;
    tab.rows[2] = tab.rows[2]!.map((cell, index) =>
      index === idColumn ? cell : { value: null, formatted: "" },
    );
    await pull();
    expect(
      await db().query(
        "select kind from attention_items where kind = 'duplicate_knit_id'",
      ),
    ).toEqual([]);

    // The nightly check reads G01's own row, not the cleared one below it.
    const store = storeFor(db());
    expect(
      await mismatchCheck({ store, source }, await store.trackers()),
    ).toMatchObject({ mismatches: 0 });

    await setStatus(g01, "done");
    expect(await push()).toMatchObject({ claimed: 1, done: 1 });
    expect(await sheetRow(source, ctx.ref, g01)).toMatchObject({
      status: "Done",
    });
    expect(
      (await source.readRows(ctx.ref, 1))
        .filter((r) => r.cells.status?.formatted === "Done")
        .map((r) => r.rowNumber),
    ).toEqual([2]);
  });

  it("a status-read column Knit does not write keeps its last pulled word, so a person's change there reaches the next pull (N23)", async () => {
    const config = fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS) as {
      columns: Record<string, unknown>;
    };
    // Status is read from "Status" and written to "Notes": two different columns.
    await restart({ columns: { ...config.columns, statusWrite: "Notes" } });
    const g01 = await taskId(db(), "G01");
    // Someone marks G01 done in the sheet; before the next pull, Knit sets it In progress.
    await source.setCell(ctx.ref, 1, 2, "Status", "Done");
    await setStatus(g01, "in_progress");
    expect(await push()).toMatchObject({ done: 1 });
    const [task] = await db().query<{ source_snapshot: unknown }>(
      "select source_snapshot from tasks where id = $1",
      [g01],
    );
    expect(task!.source_snapshot).toEqual({
      statusKey: "not started",
      completedOn: null,
      status: "yet_to_start",
    });
    // The sheet's Done is a change in a cell Knit did not write: the next pull applies it.
    await pull();
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

// N49, 6.10, invariant 8: every RPC that changes a tracker's tasks takes the tracker lock before
// the task's. push_result's superseded-and-resent branch moves the tracker's state_version, so
// it locks the tracker first too, then the task, then the write-back. Two transactions taking
// these locks in opposite orders could deadlock; one connection cannot show that, so the
// functions' own lock statements are checked in order.
describe("lock order (N49)", () => {
  const db = useTestDb();

  async function source(name: string) {
    const [fn] = await db().query<{ src: string }>(
      "select prosrc as src from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace",
      [name],
    );
    const src = fn!.src;
    return (pattern: RegExp) => {
      const match = pattern.exec(src);
      expect(match, String(pattern)).not.toBeNull();
      return match!.index;
    };
  }

  it("push_result locks the tracker, then the task, then the write-back, before moving state_version", async () => {
    const at = await source("push_result");
    // FOR NO KEY UPDATE: it waits for the N49 RPCs' FOR UPDATE, but never for the FOR KEY SHARE
    // a foreign-key insert takes on the tracker (events, outbox, attention_items).
    const tracker = at(
      /from trackers where id = v_tracker_id for no key update;/,
    );
    const task = at(/from tasks where id = v_task_id for update/);
    const outbox = at(/from outbox where id = p_outbox_id for update/);
    const stateVersion = at(/update trackers set state_version/);
    expect(tracker).toBeLessThan(task);
    expect(task).toBeLessThan(outbox);
    expect(outbox).toBeLessThan(stateVersion);
  });

  it("the holiday trigger locks the trackers before it moves task-days off a new holiday", async () => {
    const at = await source("holidays_refresh_calendar");
    const trackers = at(/order by t\.id\s+for update of t;/);
    const moved = at(/update task_days d\s+set day = v_next/);
    const events = at(/insert into events/);
    const stateVersion = at(/update trackers set state_version/);
    expect(trackers).toBeLessThan(moved);
    expect(moved).toBeLessThan(events);
    expect(events).toBeLessThan(stateVersion);
  });
});
