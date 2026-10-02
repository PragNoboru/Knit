import { beforeEach, describe, expect, it } from "vitest";

import { DayViewData } from "@/lib/domain/day-view";
import { TaskDetail } from "@/lib/domain/tasks-screens";
import {
  memoryFile,
  MemorySheetSource,
  type MemoryFile,
} from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFile } from "@/lib/sheets/xlsx";
import { pullTracker } from "@/lib/sync/pull";
import { toSheetsSerial } from "@/lib/time";

import { createUser, fixtureTrackerConfig } from "./support/builders";
import { queryAs, setToday, useTestDb, type Db } from "./support/db";
import { storeFor } from "./support/store";

// PRD 6.7, N72, N73, N75: a tracker with a checking owner column (Owner) beside the owner
// column (Maker), pulled against the real SQL. The Maker is assigned; a blank Maker hands the
// row to the Owner; the card (20261002100000_task_card_checker) carries the Owner's text.

const TODAY = "2026-09-30"; // Wed
const d = (iso: string) => toSheetsSerial(iso);
const HEADERS = ["Task ID", "Date", "Task", "Owner", "Maker", "Status"];
const grid = (): (string | number | null)[][] => [
  HEADERS,
  ["T-1", d(TODAY), "Checked by Shlok", "Shlok", "Pragaman", "Not started"],
  ["T-2", d(TODAY), "No maker", "Pragaman", null, "Not started"],
  ["T-3", d(TODAY), "Made by Shlok", "Pragaman", "Shlok", "Not started"],
  ["T-4", d(TODAY), "Both", "Pragaman", "Pragaman, Shlok", "In progress"],
];

const config = (checker: string | null) => ({
  headerRow: 1,
  columns: {
    date: "Date",
    title: "Task",
    statusRead: "Status",
    statusWrite: "Status",
    completedOn: null,
    owner: "Maker",
    checker,
    sourceRef: "Task ID",
    critical: null,
  },
  readOnlyColumns: [],
  titleTemplate: "{Task}",
  subtitleTemplate: null,
  detailColumns: [],
  ownerSeparators: [","],
  ownerFilter: "mine",
  offDayPolicy: "previous_working_day",
  statusMap: {
    "not started": "yet_to_start",
    "in progress": "in_progress",
    blocked: "blocked",
    done: "done",
    cancelled: "cancelled",
    "": "yet_to_start",
  },
  cancelReasons: {},
  writeBack: {
    yet_to_start: "Not started",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
  },
  completedOnFormat: null,
});

async function setup(
  db: Db,
  source: MemorySheetSource,
  file: MemoryFile,
  checker: string | null,
) {
  const me = await createUser(db, { name: "Pragaman" });
  const shlok = await createUser(db, { name: "Shlok" });
  await db.query(
    `insert into people_aliases (alias_norm, display, user_id)
     values ('pragaman', 'Pragaman', $1), ('shlok', 'Shlok', $2)`,
    [me, shlok],
  );
  const ref: TabRef = { fileId: file.id, sheetId: 0 };
  await source.ensureKnitColumns(ref, 1);
  await db.query(
    `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
    [file.id, file.name],
  );
  const [tracker] = await db.query<{ id: string }>(
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
     values ($1, 0, 'Tasks', 'Owner and Maker', 'teal', 'active', $2::jsonb, $3) returning id`,
    [file.id, JSON.stringify(config(checker)), "2026-09-28"],
  );
  return { me, shlok, ref, trackerId: tracker!.id };
}

describe("a tracker with a checking owner column (N73)", () => {
  const db = useTestDb();
  let file: MemoryFile;
  let source: MemorySheetSource;
  let ctx: Awaited<ReturnType<typeof setup>>;

  const pull = async () => {
    const store = storeFor(db());
    const [tracker] = await store.trackers({ ids: [ctx.trackerId] });
    return pullTracker({ store, source }, tracker!, { force: true });
  };
  const today = async (user: string) => {
    const [row] = await queryAs<{ v: unknown }>(
      db(),
      { kind: "user", id: user },
      "select day_view($1) as v",
      [TODAY],
    );
    return DayViewData.parse(row!.v);
  };
  const owners = (view: DayViewData) =>
    Object.fromEntries(
      view.rows.map((card) => [card.sourceRef, card.checker?.raw ?? null]),
    );

  describe("mapped", () => {
    beforeEach(async () => {
      await setToday(db(), TODAY);
      file = memoryFile("Owner and Maker", grid(), { title: "Tasks" });
      source = new MemorySheetSource([file]);
      ctx = await setup(db(), source, file, "Owner");
    });

    it("assigns the Maker, or the Owner when Maker is blank, and the card shows the Owner", async () => {
      expect(await pull()).toMatchObject({ outcome: "pulled" });
      const mine = await today(ctx.me);
      expect(owners(mine)).toEqual({
        "T-1": "Shlok",
        "T-2": "Pragaman",
        "T-4": "Pragaman",
      });
      expect(mine.rows[0]!.checker?.header).toBe("Owner");
      // T-3 belongs to its Maker alone, though Pragaman is its Owner.
      expect(owners(await today(ctx.shlok))).toEqual({
        "T-3": "Pragaman",
        "T-4": "Pragaman",
      });
      const [stored] = await db().query<{
        details: unknown;
        owner_raw: unknown;
      }>("select details, owner_raw from tasks where source_ref = 'T-2'");
      expect(stored).toEqual({
        details: { Owner: "Pragaman" },
        owner_raw: null,
      });
    });

    it("the drawer gets the Owner on its card and the Maker as ownerRaw", async () => {
      await pull();
      const [task] = await db().query<{ id: string }>(
        "select id::text from tasks where source_ref = 'T-1'",
      );
      const [row] = await queryAs<{ v: unknown }>(
        db(),
        { kind: "user", id: ctx.me },
        "select task_detail($1) as v",
        [task!.id],
      );
      const detail = TaskDetail.parse(row!.v);
      expect(detail.card.checker).toEqual({ header: "Owner", raw: "Shlok" });
      expect(detail.ownerRaw).toBe("Pragaman");
    });

    it("follows edits of the Owner and Maker cells, and a second pull changes nothing", async () => {
      await pull();
      await source.setCell(ctx.ref, 1, 2, "Owner", "Riya");
      await source.setCell(ctx.ref, 1, 3, "Owner", "Shlok");
      expect(await pull()).toMatchObject({ stats: { updated: 2 } });
      // T-2's Maker is blank, so the new Owner takes it over.
      expect(owners(await today(ctx.me))).toEqual({
        "T-1": "Riya",
        "T-4": "Pragaman",
      });
      expect(owners(await today(ctx.shlok))).toMatchObject({ "T-2": "Shlok" });
      expect(await pull()).toMatchObject({
        stats: { inserted: 0, updated: 0, removed: 0 },
      });
    });
  });

  describe("not mapped", () => {
    beforeEach(async () => {
      await setToday(db(), TODAY);
      file = memoryFile("Owner and Maker", grid(), { title: "Tasks" });
      source = new MemorySheetSource([file]);
      ctx = await setup(db(), source, file, null);
    });

    it("reads as before: only the Maker assigns, and cards carry no checker", async () => {
      await pull();
      const mine = await today(ctx.me);
      expect(owners(mine)).toEqual({ "T-1": null, "T-4": null });
      expect(mine.rows.every((card) => card.checker === null)).toBe(true);
      const [stored] = await db().query<{ details: unknown }>(
        "select details from tasks where source_ref = 'T-1'",
      );
      expect(stored).toEqual({ details: {} });
    });
  });
});

describe("the Knit Standard Tracker v2 example (11.1, N74)", () => {
  const db = useTestDb();

  it("pulls with the standard setup's registry: the Maker's tasks, with their Owner", async () => {
    await setToday(db(), TODAY);
    const file = loadXlsxFile(
      "fixtures/trackers/Knit_Standard_Tracker_v2_example.xlsx",
    );
    const source = new MemorySheetSource([file]);
    const me = await createUser(db(), { role: "admin", name: "Pragaman" });
    await db().query(
      `insert into people_aliases (alias_norm, display, user_id)
       values ('pragaman', 'Pragaman', $1), ('p', 'P', $1), ('creative', 'Creative', null),
              ('shlok', 'Shlok', null), ('aryan', 'Aryan', null)`,
      [me],
    );
    await source.ensureKnitColumns({ fileId: file.id, sheetId: 0 }, 1);
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values ($1, $2, 'application/vnd.google-apps.spreadsheet', 'connected')`,
      [file.id, file.name],
    );
    const [tracker] = await db().query<{ id: string }>(
      `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
       values ($1, 0, 'Tasks', 'Knit Standard v2 · Example', 'violet', 'active', $2::jsonb, $3) returning id`,
      [
        file.id,
        JSON.stringify(fixtureTrackerConfig("Knit Standard v2 · Example")),
        "2026-10-01",
      ],
    );
    const pull = async () => {
      const store = storeFor(db());
      const [synced] = await store.trackers({ ids: [tracker!.id] });
      return pullTracker({ store, source }, synced!, { force: true });
    };
    expect(await pull()).toMatchObject({
      outcome: "pulled",
      stats: { rows: 10, inserted: 10 },
    });
    // NOB-08 is Creative's to make, though Pragaman is its Owner; no Riya item (N73).
    const [counts] = await db().query(
      `select (select count(*)::int from task_assignees) as assigned,
              (select count(*)::int from attention_items where kind = 'unknown_owner') as unknown`,
    );
    expect(counts).toEqual({ assigned: 9, unknown: 0 });

    const [row] = await queryAs<{ v: unknown }>(
      db(),
      { kind: "user", id: me },
      "select day_view($1) as v",
      ["2026-10-01"],
    );
    const day = DayViewData.parse(row!.v);
    const budget = day.rows.find((card) => card.sourceRef === "NOB-03");
    expect(budget?.checker).toEqual({ header: "Owner", raw: "Shlok" });

    const snapshot = () =>
      db().query(
        `select (select jsonb_agg(to_jsonb(k) - 'updated_at' - 'source_synced_at' order by id) from tasks k) as tasks,
                (select jsonb_agg(to_jsonb(d) order by d.id) from task_days d) as days,
                (select count(*)::int from events) as events`,
      );
    const before = await snapshot();
    expect(await pull()).toMatchObject({
      stats: { inserted: 0, updated: 0, removed: 0 },
    });
    expect(await snapshot()).toEqual(before);
  });
});
