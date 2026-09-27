import { describe, expect, it } from "vitest";

import { memoryFile, MemorySheetSource } from "@/lib/sheets/memory";
import { pullTracker } from "@/lib/sync/pull";
import { addDays, formatDate } from "@/lib/time";

import {
  createUser,
  fixtureTrackerConfig,
  FILING_BUDDY_GOOGLE_ADS,
} from "./support/builders";
import { driver, queryAs, setToday, useTestDb } from "./support/db";
import { storeFor } from "./support/store";

// PRD 15: Today answers in under 300 ms for 1,000 tasks, and a 1,000-row tracker pulls in under
// 20 s. The limits are checked on local Supabase (the reference, as in CI); in-process Postgres
// (PGlite, WebAssembly) is several times slower, so there they are only a loose guard.

const TODAY = "2026-09-28";
const ROWS = 1000;
const SLOWER = driver === "pglite" ? 10 : 1;

const HEADERS = [
  "ID",
  "Phase",
  "Date",
  "Task",
  "Owner",
  "Status",
  "Done on",
  "Blocks go-live?",
  "Details / done when",
  "Depends on",
  "Ref",
  "Notes",
];

function bigTracker() {
  const rows: (string | null)[][] = [HEADERS];
  for (let i = 0; i < ROWS; i += 1) {
    // Spread over twelve weeks from today, a fifth of them today.
    const day = i % 5 === 0 ? TODAY : addDays(TODAY, 1 + (i % 84));
    rows.push([
      `P${i}`,
      "Launch",
      formatDate(day, "dd/MM/yyyy"),
      `Task number ${i}`,
      "Pragaman",
      "Not started",
      null,
      i % 10 === 0 ? "Yes" : "No",
      `Detail ${i}`,
      null,
      null,
      null,
    ]);
  }
  return memoryFile("Big tracker", rows, { title: "Tasks" });
}

describe("performance (PRD 15)", () => {
  const db = useTestDb();

  it(`pulls a ${ROWS}-row tracker in under 20 s, then Today answers in under 300 ms`, async () => {
    await setToday(db(), TODAY);
    const me = await createUser(db(), { name: "Pragaman" });
    await db().query(
      "insert into people_aliases (alias_norm, display, user_id) values ('pragaman', 'Pragaman', $1)",
      [me],
    );
    const file = bigTracker();
    const source = new MemorySheetSource([file]);
    await source.ensureKnitColumns({ fileId: file.id, sheetId: 0 }, 1);
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
      [file.id, file.name],
    );
    const [row] = await db().query<{ id: string }>(
      `insert into trackers (file_id, sheet_gid, tab_name, name, color, owner_user_id, state, config, go_live_date)
       values ($1, 0, 'Tasks', 'Big tracker', 'teal', $2, 'active', $3::jsonb, $4) returning id`,
      [
        file.id,
        me,
        JSON.stringify(fixtureTrackerConfig(FILING_BUDDY_GOOGLE_ADS)),
        TODAY,
      ],
    );
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [row!.id] });

    const pullStarted = performance.now();
    const outcome = await pullTracker({ store, source }, tracker!, {
      force: true,
    });
    const pullMs = performance.now() - pullStarted;
    expect(outcome).toMatchObject({ outcome: "pulled" });
    expect(await db().query("select count(*)::int as n from tasks")).toEqual([
      { n: ROWS },
    ]);
    expect(pullMs).toBeLessThan(20_000 * SLOWER);

    // Today for the owner of all 1,000 tasks: the best of three calls, as a warm server.
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      const [view] = await queryAs<{ v: { rows: unknown[] } }>(
        db(),
        { kind: "user", id: me },
        "select day_view(null) as v",
      );
      times.push(performance.now() - started);
      expect(view!.v.rows).toHaveLength(ROWS / 5);
    }
    expect(Math.min(...times)).toBeLessThan(300 * SLOWER);
  }, 300_000);
});
