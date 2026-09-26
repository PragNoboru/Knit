import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";

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
      source_snapshot: { statusKey: "done", completedOn: TODAY },
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
});
