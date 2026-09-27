import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { MemoryArchive, type ArchiveRows } from "@/lib/sync/archive";
import { closeDays, mismatchCheck } from "@/lib/sync/close";
import { pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 10.5, 10.6, 10.7, 17 (M6): the close-days job on the Filing Buddy tracker.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const GO_LIVE = "2026-09-28";

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
     values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', 'active', $2::jsonb, $3) returning id`,
    [
      file.id,
      JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
      GO_LIVE,
    ],
  );
  await setToday(db, GO_LIVE);
  const store = storeFor(db);
  const [synced] = await store.trackers({ ids: [tracker!.id] });
  await pullTracker({ store, source }, synced!, { force: true });
  return { me, ref, trackerId: tracker!.id };
}

const taskId = async (db: Db, ref: string) =>
  (
    await db.query<{ id: string }>(
      "select id::text from tasks where source_ref = $1",
      [ref],
    )
  )[0]!.id;

const days = (db: Db, ref: string) =>
  db.query<{
    day: string;
    status: string;
    spill_index: number;
    locked: boolean;
  }>(
    `select d.day::text, d.status::text, d.spill_index, d.locked
     from task_days d join tasks k on k.id = d.task_id where k.source_ref = $1 order by d.day`,
    [ref],
  );

describe("close-days job (PRD 10.5)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let archive: MemoryArchive;
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    archive = new MemoryArchive();
    ctx = await setup(db(), source, file);
    // G01 is done on Mon 28 Sep; nothing else is touched. Then the job is down until Thu 1 Oct.
    await queryAs(
      db(),
      { kind: "user", id: ctx.me },
      "select set_task_status($1, 'done')",
      [await taskId(db(), "G01")],
    );
    await pushDue({ store: storeFor(db()), source });
    await setToday(db(), "2026-10-01");
  });

  const run = () => closeDays({ store: storeFor(db()), source, archive });

  it("catches up a 3-day gap in date order, spilling to working days", async () => {
    const result = await run();
    expect(result.failed).toBeNull();
    expect(result.closed.map((c) => c.day)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
    expect(result.closed[0]!.stats).toMatchObject({
      locked_as_is: 1,
      not_done: 13,
      spillovers: 13,
      mismatches: 0,
    });

    expect(await days(db(), "G01")).toEqual([
      { day: "2026-09-28", status: "done", spill_index: 0, locked: true },
    ]);
    expect(await days(db(), "G02")).toEqual([
      { day: "2026-09-28", status: "not_done", spill_index: 0, locked: true },
      { day: "2026-09-29", status: "not_done", spill_index: 1, locked: true },
      { day: "2026-09-30", status: "not_done", spill_index: 2, locked: true },
      {
        day: "2026-10-01",
        status: "yet_to_start",
        spill_index: 3,
        locked: false,
      },
    ]);
    const closures = await db().query(
      "select day::text, state from day_closures order by day",
    );
    expect(closures).toEqual([
      { day: "2026-09-28", state: "closed" },
      { day: "2026-09-29", state: "closed" },
      { day: "2026-09-30", state: "closed" },
    ]);
  });

  it("does nothing when run again", async () => {
    await run();
    const before = await db().query("select count(*)::int as n from task_days");
    expect(await run()).toEqual({ closed: [], failed: null });
    expect(
      await db().query("select count(*)::int as n from task_days"),
    ).toEqual(before);
  });

  it("keeps each day's rows in the Knit Archive, replaced (never duplicated) on a re-run", async () => {
    // Events are archived by the IST date they happened; the test clock only freezes the
    // business date, so place G01's change on 28 Sep.
    await db().query("update events set at = '2026-09-28 12:00:00+05:30'");
    await run();
    const onDay = (rows: string[][], day: string) =>
      rows.filter((r) => r[0] === day).length;
    expect(onDay(archive.tabs.taskDays, "2026-09-28")).toBe(14);
    await archive.replaceDay(
      "2026-09-28",
      (await storeFor(db()).archiveRows("2026-09-28")) as ArchiveRows,
    );
    expect(onDay(archive.tabs.taskDays, "2026-09-28")).toBe(14);
    expect(onDay(archive.tabs.events, "2026-09-28")).toBeGreaterThan(0);
  });

  it("refreshes Knit Notes after the close without touching statuses (N17)", async () => {
    await run();
    await pushDue({ store: storeFor(db()), source });
    const rows = await source.readRows(ctx.ref, 1);
    const g02 = rows.find((r) => r.cells.id?.formatted === "G02")!;
    expect(g02.cells["knit note"]!.formatted).toBe(
      "Spilled 3x · now due Thu 1 Oct",
    );
    expect(g02.cells.status!.formatted).toBe("Not started");
  });

  it("a note refresh never counts as a change made in Knit: a sheet edit still wins (N17, 10.3)", async () => {
    await run();
    const g02 = await taskId(db(), "G02");
    expect(
      await db().query(
        "select count(*)::int as n from outbox where task_id = $1 and state = 'pending'",
        [g02],
      ),
    ).toEqual([{ n: 1 }]);
    await source.setCell(ctx.ref, 1, 3, "Status", "In progress");
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    await pullTracker({ store, source }, tracker!, { force: true });
    const [task] = await db().query(
      "select status::text from tasks where id = $1",
      [g02],
    );
    expect(task).toEqual({ status: "in_progress" });
    expect(
      await db().query(
        "select count(*)::int as n from attention_items where kind = 'conflict'",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("a status write-back beats a newer note refresh when both wait (push_claim, N17)", async () => {
    const g02 = await taskId(db(), "G02");
    await db().query(
      `insert into outbox (task_id, tracker_id, payload) values
         ($1, $2, '{"status_value": "Done", "completed_on": null}'),
         ($1, $2, '{"note_only": true}')`,
      [g02, ctx.trackerId],
    );
    const claimed = (await storeFor(db()).pushClaim(10, g02)) as {
      payload: Record<string, unknown>;
    }[];
    expect(claimed.map((c) => c.payload)).toEqual([
      { status_value: "Done", completed_on: null },
    ]);
    const states = await db().query(
      "select state::text, payload ? 'note_only' as note from outbox where task_id = $1 order by id",
      [g02],
    );
    expect(states).toEqual([
      { state: "pending", note: false },
      { state: "superseded", note: true },
    ]);
  });

  it("marks a day failed when a step breaks, and starts it again on the next call", async () => {
    let broken = true;
    const flaky: typeof archive = Object.assign(new MemoryArchive(), {
      async replaceDay(day: string, rows: ArchiveRows) {
        if (broken) throw new Error("Archive unavailable");
        return MemoryArchive.prototype.replaceDay.call(archive, day, rows);
      },
    });
    const first = await closeDays({
      store: storeFor(db()),
      source,
      archive: flaky,
    });
    expect(first.failed).toMatchObject({ day: "2026-09-28" });
    expect(await db().query("select state, error from day_closures")).toEqual([
      { state: "failed", error: "Error: Archive unavailable" },
    ]);
    broken = false;
    const second = await closeDays({
      store: storeFor(db()),
      source,
      archive: flaky,
    });
    expect(second.closed.map((c) => c.day)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });

  it("counts sheet statuses that disagree with Knit in the nightly mismatch check (10.6)", async () => {
    await run();
    await source.setCell(ctx.ref, 1, 2, "Status", "Blocked"); // G01 is Done in Knit
    const store = storeFor(db());
    expect(
      await mismatchCheck({ store, source }, await store.trackers()),
    ).toEqual({ checked: 34, mismatches: 1 });
    expect(
      await db().query(
        "select kind, detail ->> 'sheet' as sheet from attention_items",
      ),
    ).toEqual([{ kind: "conflict", sheet: "Blocked" }]);
  });
});
