import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { mismatchCheck } from "@/lib/sync/close";
import { pullAll, pullTracker } from "@/lib/sync/pull";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD N28 (decided 1 Oct 2026), N60, N24, N27, N34, 11 (Editing a live tracker's mapping
// later): a remapped status word keeps its old meaning on rows that already show it; the new
// mapping reaches new rows and rows whose word changes later. A word mapped for the first time
// applies to every row that shows it. Against the real SQL, on the Filing Buddy tracker.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const TODAY = "2026-09-28";
const G01_ROW = 2;

async function setup(db: Db, source: MemorySheetSource, file: MemoryFile) {
  const me = await createUser(db, { role: "admin", name: "Pragaman" });
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
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, owner_user_id, state, config, go_live_date)
     values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', $2, 'active', $3::jsonb, $4)
     returning id`,
    [
      file.id,
      me,
      JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
      TODAY,
    ],
  );
  return { me, ref, trackerId: tracker!.id };
}

describe("a remapped status word (PRD N28, N60)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
  });

  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  /** The scheduled pull: not forced, so it runs only for a changed sheet or an owed pull. */
  const cronPull = async () =>
    (await pullAll({ store: storeFor(db()), source }))[0]?.outcome;
  /** Edit mapping or Map status (N19 d): the saved config bumps pull_requested (N44). */
  const mapWord = (word: string, status: string) =>
    db().query(
      `update trackers set config = jsonb_set(config, array['statusMap', $2::text], to_jsonb($3::text))
       where id = $1`,
      [ctx.trackerId, word, status],
    );
  const setG01 = (header: string, value: string) =>
    source.setCell(ctx.ref, 1, G01_ROW, header, value);
  const g01 = async () =>
    (
      await db().query<{
        id: string;
        status: string;
        completed_on: string | null;
        snapshot: Record<string, unknown>;
      }>(
        `select id::text, status::text, completed_on::text, source_snapshot as snapshot
         from tasks where source_ref = 'G01'`,
      )
    )[0]!;
  /** Everything a pull can change. */
  const state = async () =>
    db().query(
      `select
         (select jsonb_agg(to_jsonb(k) - 'updated_at' - 'source_synced_at' order by id) from tasks k where tracker_id = $1) as tasks,
         (select jsonb_agg(to_jsonb(d) order by d.id) from task_days d join tasks k on k.id = d.task_id where k.tracker_id = $1) as days,
         (select count(*)::int from events where tracker_id = $1) as events,
         (select count(*)::int from outbox where tracker_id = $1) as outbox,
         (select count(*)::int from attention_items where tracker_id = $1) as attention`,
      [ctx.trackerId],
    );
  const conflicts = () =>
    db().query(
      "select count(*)::int as n from attention_items where kind = 'conflict'",
    );

  it("Edit mapping on a live tracker: the owed pull changes no task, task-day, event, item or write-back", async () => {
    await pull();
    await setG01("Status", "Done");
    await pull();
    expect(await g01()).toMatchObject({ status: "done", completed_on: TODAY });

    await mapWord("done", "in_progress");
    const before = await state();
    expect(await cronPull()).toBe("pulled");
    expect(await state()).toEqual(before);
    expect(await conflicts()).toEqual([{ n: 0 }]);
    // The request was served: the sheet is quiet, so the next scheduled pull skips it.
    expect(await cronPull()).toBe("skipped");
  });

  it("Map status for an unmapped word: rows showing it take the new status (N60)", async () => {
    await setG01("Status", "Copy ready");
    await pull();
    // A new task: apply_pull_plan stores JSON null as the status of an unmapped word.
    const stored = await g01();
    expect(stored.status).toBe("yet_to_start");
    expect(stored.snapshot).toEqual({
      statusKey: "copy ready",
      status: null,
      completedOn: null,
    });
    expect(
      await db().query(
        "select dedupe_key from attention_items where kind = 'unmapped_status'",
      ),
    ).toEqual([{ dedupe_key: "unmapped_status:copy ready" }]);

    await mapWord("copy ready", "done");
    expect(await cronPull()).toBe("pulled");
    const mapped = await g01();
    expect(mapped).toMatchObject({ status: "done", completed_on: TODAY });
    expect(mapped.snapshot).toEqual({
      statusKey: "copy ready",
      status: "done",
      completedOn: null,
    });
  });

  it("the self-conflict rule reads the word by its recorded status (N27)", async () => {
    await pull();
    await setG01("Status", "Done");
    await pull();
    await mapWord("done", "in_progress");
    // Knit changes the task and back: its Done write-back waits. The write lands in the sheet
    // but the push has not recorded it yet when the pull runs.
    for (const status of ["in_progress", "done"]) {
      await queryAs(
        db(),
        { kind: "user", id: ctx.me },
        "select set_task_status($1, $2::knit_status, null)",
        [(await g01()).id, status],
      );
    }
    await setG01("Done on", "Mon 28 Sep");
    expect(await pull()).toMatchObject({ stats: { conflicts: 0 } });
    expect(await conflicts()).toEqual([{ n: 0 }]);
    expect((await g01()).status).toBe("done");
  });

  it("push_result keeps a null status in the merged snapshot (10.4 step 5)", async () => {
    await pull();
    const { id } = await g01();
    await queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, 'in_progress', null)",
      [id],
    );
    const [outbox] = await db().query<{ id: string }>(
      "select id::text from outbox where task_id = $1 and state = 'pending'",
      [id],
    );
    await storeFor(db()).pushResult(
      outbox!.id,
      true,
      { statusKey: "copy ready", status: null },
      null,
    );
    const [row] = await db().query<{ status_is_null: boolean; key: string }>(
      `select source_snapshot -> 'status' = 'null'::jsonb as status_is_null,
              source_snapshot ->> 'statusKey' as key
       from tasks where id = $1`,
      [id],
    );
    expect(row).toEqual({ status_is_null: true, key: "copy ready" });
  });
});

describe("the nightly mismatch check after a remap (PRD N34, N28)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ctx = await setup(db(), source, file);
  });

  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  const mapWord = (word: string, status: string) =>
    db().query(
      `update trackers set config = jsonb_set(config, array['statusMap', $2::text], to_jsonb($3::text))
       where id = $1`,
      [ctx.trackerId, word, status],
    );
  const check = async () => {
    const store = storeFor(db());
    return (await mismatchCheck({ store, source }, await store.trackers()))
      .mismatches;
  };
  const outbox = () =>
    db().query("select count(*)::int as n from outbox where tracker_id = $1", [
      ctx.trackerId,
    ]);

  it("a word read as Knit's status keeps agreeing after it is remapped; another word still disagrees", async () => {
    // "Copy ready" means Done when the pull reads it; then the admin remaps it.
    await mapWord("copy ready", "done");
    await pull();
    await source.setCell(ctx.ref, 1, G01_ROW, "Status", "Copy ready");
    await pull();
    await mapWord("copy ready", "in_progress");

    expect(await check()).toBe(0);
    expect(
      await db().query(
        "select count(*)::int as n from attention_items where kind = 'conflict'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(await outbox()).toEqual([{ n: 0 }]);

    await source.setCell(ctx.ref, 1, G01_ROW, "Status", "Blocked");
    expect(await check()).toBe(1);
  });

  it("a word unmapped when read is read through the current map once mapped", async () => {
    await pull();
    await source.setCell(ctx.ref, 1, G01_ROW, "Status", "Copy ready");
    await pull();
    // Mapped for the first time to the task's status (Yet to Start), before any pull.
    await mapWord("copy ready", "yet_to_start");
    expect(await check()).toBe(0);
  });
});
