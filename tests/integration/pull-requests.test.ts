import { beforeEach, describe, expect, it } from "vitest";

import { MemorySheetSource, type MemoryFile } from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullAll, pullTracker } from "@/lib/sync/pull";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 11 (saving a mapping runs a forced pull), N19(d), 12.8, 10.2 step 1 (audit findings 37,
// 44): a change the pull reads besides the sheet (config, aliases, calendar) is owed a pull,
// even when the admin's own forced pull was skipped for the lease or a pull that loaded the
// old config ran meanwhile. The next pull never skips that tracker.

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
  return { admin, trackerId: tracker!.id };
}

describe("pulls owed after a change the sheet does not show", () => {
  const db = useTestDb();
  let source: MemorySheetSource;
  let trackerId: string;

  beforeEach(async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(FIXTURE);
    source = new MemorySheetSource([file]);
    ({ trackerId } = await setup(db(), source, file));
    // Import once (it writes the Knit IDs), then once more so the sheet is quiet.
    await pullAll({ store: storeFor(db()), source }, { force: true });
    await pullAll({ store: storeFor(db()), source });
  });

  const cronPull = async () =>
    (await pullAll({ store: storeFor(db()), source }))[0]?.outcome;
  const changeConfig = () =>
    db().query(
      `update trackers set config = jsonb_set(config, '{offDayPolicy}', '"next_working_day"')
       where id = $1`,
      [trackerId],
    );

  it("an unchanged sheet is skipped until something it depends on changes", async () => {
    expect(await cronPull()).toBe("skipped");
    await changeConfig();
    expect(await cronPull()).toBe("pulled");
    expect(await cronPull()).toBe("skipped");
  });

  it("a pull that loaded the old config cannot clear the request", async () => {
    const store = storeFor(db());
    // A pull starts: it reads what is owed, then the tracker with its config.
    const requests = await store.pullRequests([trackerId]);
    const [stale] = await store.trackers({ ids: [trackerId] });
    // The admin saves a mapping meanwhile; their own forced pull finds the lease taken.
    await changeConfig();
    // The running pull finishes with the old config and records the sheet as seen.
    expect(
      await pullTracker({ store, source }, stale!, {
        force: true,
        request: requests[trackerId],
      }),
    ).toMatchObject({ outcome: "pulled" });
    // The next cron pull (not forced, sheet unchanged) still pulls, with the new config.
    expect(await cronPull()).toBe("pulled");
    expect(await cronPull()).toBe("skipped");
  });

  it("people aliases and holidays make every syncing tracker owed a pull", async () => {
    await db().query(
      "insert into people_aliases (alias_norm, display, user_id) values ('agent', 'Agent', null)",
    );
    expect(await cronPull()).toBe("pulled");
    expect(await cronPull()).toBe("skipped");
    await db().query(
      "insert into holidays (day, name) values ('2026-12-24', 'Office closed')",
    );
    expect(await cronPull()).toBe("pulled");
    expect(await cronPull()).toBe("skipped");
  });

  it("the request functions are for the jobs only", async () => {
    const [row] = await db().query<{ requested: string; served: string }>(
      "select pull_requested::text as requested, pull_served::text as served from trackers where id = $1",
      [trackerId],
    );
    expect(row).toEqual({ requested: "0", served: "0" });
    await db().query("savepoint member");
    await db().query("set local role authenticated");
    await expect(db().query("select pull_requests()")).rejects.toThrow(
      /permission denied/,
    );
    await db().query("rollback to savepoint member");
  });
});
