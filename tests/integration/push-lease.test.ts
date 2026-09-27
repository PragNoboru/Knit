import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pushTaskImmediately, pushTaskUnderLease } from "@/lib/sync/leases";
import { pullTracker } from "@/lib/sync/pull";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb } from "./support/db";
import { storeFor } from "./support/store";

// PRD 7.3, 10.4 step 1 (newest per task wins): the immediate push after a status change holds
// the push lease like every push, so a task's newer write-back is never written while a push
// that claimed its older one is still writing.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";
const TODAY = "2026-09-28";

describe("immediate push under the push lease (PRD 7.3, 10.4)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let ref: TabRef;
  let me: string;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ref = { fileId: file.id, sheetId: 0 };
    me = await createUser(db(), { role: "member", name: "Pragaman" });
    await db().query(
      "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
      [me],
    );
    await source.ensureKnitColumns(ref, 1);
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
      [file.id, file.name],
    );
    const [tracker] = await db().query<{ id: string }>(
      `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
       values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', 'active', $2::jsonb, $3) returning id`,
      [
        file.id,
        JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
        TODAY,
      ],
    );
    const store = storeFor(db());
    const [synced] = await store.trackers({ ids: [tracker!.id] });
    await pullTracker({ store, source }, synced!, { force: true });
  });

  const setStatus = (taskId: string, status: string) =>
    queryAs(
      db(),
      { kind: "user", id: me },
      "select set_task_status($1, $2::knit_status)",
      [taskId, status],
    );

  const statusCell = async (id: string) =>
    (await source.readRows(ref, 1)).find((r) => r.cells.id?.formatted === id)!
      .cells.status!.formatted;

  it("waits while another push holds the lease, so the newer write-back lands last", async () => {
    const store = storeFor(db());
    const g01 = (
      await db().query<{ id: string }>(
        "select id::text from tasks where source_ref = 'G01'",
      )
    )[0]!.id;

    // Done is queued, and the cron push (holding the lease) claims it: its write is in flight.
    await setStatus(g01, "done");
    const holder = await store.acquireLease("push", 60);
    expect(await store.pushClaim(200, null)).toHaveLength(1);

    // The member changes it again. The immediate push must not write In progress now.
    await setStatus(g01, "in_progress");
    expect(await pushTaskUnderLease({ store, source }, g01)).toEqual({
      skipped: true,
    });
    expect(
      await db().query(
        `select state::text, next_attempt_at <= now() as due, payload ->> 'status_value' as word
         from outbox where task_id = $1 order by id`,
        [g01],
      ),
    ).toEqual([
      { state: "superseded", due: false, word: "Done" },
      { state: "pending", due: true, word: "In progress" },
    ]);

    // The running push writes Done and ends; the next push writes In progress after it.
    await source.setCell(ref, 1, 2, "Status", "Done");
    await store.releaseLease("push", holder!);
    expect(await pushTaskUnderLease({ store, source }, g01)).toMatchObject({
      skipped: false,
      result: { done: 1 },
    });
    expect(await statusCell("G01")).toBe("In progress");
  });

  it("returns only once its leased push has ended, so the lease never outlives the action's work (7.3, N33)", async () => {
    const store = storeFor(db());
    const g01 = (
      await db().query<{ id: string }>(
        "select id::text from tasks where source_ref = 'G01'",
      )
    )[0]!.id;
    await setStatus(g01, "done");
    // A slow write (a 429 backoff, in miniature) takes longer than the best-effort budget.
    class SlowWrite extends MemorySheetSource {
      override async writeCells(
        tab: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await super.writeCells(tab, headerRow, cells);
      }
    }

    expect(
      await pushTaskImmediately(
        { store, source: new SlowWrite(source.files) },
        g01,
        { timeoutMs: 20 },
      ),
    ).toEqual({ skipped: false, slow: true });
    // Nothing is left running: the write-back landed and the push lease is free again.
    expect(await statusCell("G01")).toBe("Done");
    const holder = await store.acquireLease("push", 60);
    expect(holder).not.toBeNull();
    await store.releaseLease("push", holder!);
  });
});
