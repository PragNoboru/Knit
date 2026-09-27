import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource } from "@/lib/sheets/memory";
import { KNIT_ID_HEADER, type TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import {
  previewKnitIdRecreate,
  recreateKnitIds,
} from "@/lib/sync/recreate-ids";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 14 (M8): the Knit ID column is deleted; the admin recreates it after a preview.

const FIXTURE = "fixtures/trackers/Filing_Buddy_Google_Ads_Tracker.xlsx";

describe("recreating a deleted Knit ID column (14)", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let ref: TabRef;
  let trackerId: string;

  const tracker = async (states: string[]) =>
    (await storeFor(db()).trackers({ states, ids: [trackerId] }))[0]!;
  const taskIds = (d: Db) =>
    d.query<{ id: string }>("select id::text from tasks order by source_ref");

  beforeEach(async () => {
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ref = { fileId: file.id, sheetId: 0 };
    const me = await createUser(db(), { name: "Pragaman" });
    await db().query(
      "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
      [me],
    );
    await source.ensureKnitColumns(ref, 1);
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
      [file.id, file.name],
    );
    const [row] = await db().query<{ id: string }>(
      `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
       values ($1, 0, 'Copy of Google', 'Filing Buddy · Google Ads', 'amber', 'active', $2::jsonb, '2026-09-28') returning id`,
      [file.id, JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS))],
    );
    trackerId = row!.id;
    await setToday(db(), "2026-09-28");
    await pullTracker(
      { store: storeFor(db()), source },
      await tracker(["active"]),
      {
        force: true,
      },
    );
  });

  it("pauses the tracker, previews the matches, and puts every ID back", async () => {
    const before = await taskIds(db());
    const headers = source.headers(source.tab(ref), 1);
    const knitId = headers.find((h) => h.header === KNIT_ID_HEADER)!;
    await source.deleteColumn(ref, knitId.index);

    const store = storeFor(db());
    const outcome = await pullTracker(
      { store, source },
      await tracker(["active"]),
      {
        force: true,
      },
    );
    expect(outcome).toMatchObject({ outcome: "paused" });

    const paused = await tracker(["paused"]);
    const plan = await previewKnitIdRecreate({ store, source }, paused);
    expect(plan.matches).toHaveLength(before.length);
    expect(plan.matches.every((m) => m.by === "source_id")).toBe(true);
    expect(plan.newRows).toEqual([]);
    expect(plan.missingTasks).toEqual([]);

    expect(await recreateKnitIds({ store, source }, paused)).toEqual({
      written: before.length,
      cleared: 0,
    });
    await queryAs(
      db(),
      { kind: "service" },
      "select set_tracker_state($1, 'active')",
      [trackerId],
    );
    const after = await pullTracker(
      { store, source },
      await tracker(["active"]),
      {
        force: true,
      },
    );
    expect(after).toMatchObject({ outcome: "pulled" });
    expect(await taskIds(db())).toEqual(before);
    expect(
      await db().query(
        "select count(*)::int as n from tasks where removed_at_source is not null",
      ),
    ).toEqual([{ n: 0 }]);
  });
});
