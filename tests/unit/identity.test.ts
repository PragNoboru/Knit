import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { TrackerConfig } from "@/lib/domain/config";
import { MemorySheetSource, memoryFile } from "@/lib/sheets/memory";
import type { CellWrite, TabRef } from "@/lib/sheets/types";
import { ensureKnitIds, knitIdOf } from "@/lib/sync/identity";

// PRD N30, N59, 10.2 step 4: a row that comes back with the Knit ID of a task removed at source
// gets a new Knit ID with the checks a row without one gets (N20), and no attention item.

const config = TrackerConfig.parse(
  (
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../fixtures/trackers.config.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { trackers: Record<string, unknown>[] }
  ).trackers.find((t) => t.name === "Filing Buddy · Google Ads"),
);

const HEADERS = [
  "ID",
  "Date",
  "Task",
  "Owner",
  "Status",
  "Done on",
  "Knit ID",
  "Knit Note",
];
const KNIT_ID_COLUMN = HEADERS.indexOf("Knit ID");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LIVE = "11111111-1111-4111-8111-111111111111";
const RETIRED = "22222222-2222-4222-8222-222222222222";

const line = (ref: string, task: string, knitId: string) => [
  ref,
  "Wed 30 Sep",
  task,
  "Pragaman",
  "Not started",
  "",
  knitId,
  "Spilled 2x · now due Wed 30 Sep",
];

const ref: TabRef = { fileId: "file-1", sheetId: 0 };
const noneElsewhere = async () => [];

/** Every cell of the tab, Knit ID column left out. */
const contentOf = (source: MemorySheetSource) =>
  source
    .tab(ref)
    .rows.map((row) =>
      row.filter((_, i) => i !== KNIT_ID_COLUMN).map((c) => c.formatted),
    );

function sheet(
  rows: (string | number | null)[][],
  Source: typeof MemorySheetSource = MemorySheetSource,
) {
  return new Source([
    memoryFile("Tracker", [HEADERS, ...rows], { id: "file-1" }),
  ]);
}

const read = (source: MemorySheetSource) => () =>
  source.readRows(ref, config.headerRow);

describe("ensureKnitIds: a row that comes back (N30, N59)", () => {
  let writes: CellWrite[][];

  class Recording extends MemorySheetSource {
    override async writeCells(
      r: TabRef,
      headerRow: number,
      cells: CellWrite[],
    ) {
      writes.push(cells);
      await super.writeCells(r, headerRow, cells);
    }
  }

  beforeEach(() => {
    writes = [];
  });

  it("gets a new Knit ID, written to the Knit ID cell only, with no attention item", async () => {
    const source = sheet(
      [line("G01", "Live task", LIVE), line("G02", "Came back", RETIRED)],
      Recording,
    );
    const before = contentOf(source);
    const result = await ensureKnitIds(
      source,
      ref,
      config,
      await read(source)(),
      noneElsewhere,
      read(source),
      new Set([RETIRED]),
    );

    expect(result.attention).toEqual([]);
    expect(result).toMatchObject({
      written: 1,
      cleared: 0,
      restored: 0,
      unstable: false,
    });
    expect(result.returned).toHaveLength(1);
    const [fresh] = result.returned;
    expect(fresh).toMatch(UUID);
    expect(fresh).not.toBe(RETIRED);

    expect(writes.flat()).toEqual([
      { row: 3, header: "Knit ID", kind: "text", value: fresh },
    ]);
    expect(contentOf(source)).toEqual(before);
    expect(result.rows.map((r) => [r.rowNumber, knitIdOf(r)])).toEqual([
      [2, LIVE],
      [3, fresh],
    ]);
  });

  it("recognises a retired ID typed in capitals", async () => {
    const source = sheet([line("G02", "Came back", RETIRED.toUpperCase())]);
    const result = await ensureKnitIds(
      source,
      ref,
      config,
      await read(source)(),
      noneElsewhere,
      read(source),
      new Set([RETIRED]),
    );
    expect(result.attention).toEqual([]);
    expect(result.returned).toHaveLength(1);
    expect(result.rows.map(knitIdOf)).toEqual(result.returned);
  });

  it("writes nothing for a row that moved between reading and writing", async () => {
    const source = sheet(
      [line("G01", "Live task", LIVE), line("G02", "Came back", RETIRED)],
      Recording,
    );
    const rows = await read(source)();
    let moved = false;
    const reread = async () => {
      if (!moved) {
        moved = true;
        await source.insertRow(ref, 2, []); // someone inserts a row at the top
      }
      return read(source)();
    };
    const result = await ensureKnitIds(
      source,
      ref,
      config,
      rows,
      noneElsewhere,
      reread,
      new Set([RETIRED]),
    );
    expect(writes).toEqual([]);
    expect(result.returned).toEqual([]);
    expect(result.attention).toEqual([]);
    expect(result.rows.map(knitIdOf)).toEqual([LIVE]);
  });

  it("on two rows: the upper one comes back, the lower one is a pasted copy (N22)", async () => {
    const source = sheet([
      line("G02", "Came back", RETIRED),
      line("G03", "Came back", RETIRED),
    ]);
    const result = await ensureKnitIds(
      source,
      ref,
      config,
      await read(source)(),
      noneElsewhere,
      read(source),
      new Set([RETIRED]),
    );
    const ids = result.rows.map(knitIdOf);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(RETIRED);
    // Only the upper row's new ID is a returned one.
    expect(result.returned).toEqual([ids[0]]);
    expect(result.attention).toEqual([
      {
        kind: "duplicate_knit_id",
        dedupeKey: `duplicate_knit_id:${RETIRED}`,
        detail: { knitId: RETIRED, row: 3, otherTracker: false },
      },
    ]);
  });

  it("a new ID that lands on another row: that row's own ID is put back, the retired ID is never written (N20)", async () => {
    class InsertBeforeWrite extends Recording {
      armed = true;
      override async writeCells(
        r: TabRef,
        headerRow: number,
        cells: CellWrite[],
      ) {
        if (this.armed) {
          this.armed = false;
          await this.insertRow(r, 2, []); // the live row moves into row 3
        }
        await super.writeCells(r, headerRow, cells);
      }
    }
    const source = sheet(
      [line("G01", "Live task", LIVE), line("G02", "Came back", RETIRED)],
      InsertBeforeWrite,
    );
    const result = await ensureKnitIds(
      source,
      ref,
      config,
      await read(source)(),
      noneElsewhere,
      read(source),
      new Set([RETIRED]),
    );
    expect(result).toMatchObject({ restored: 1, cleared: 0, unstable: false });
    expect(result.returned).toEqual([]);
    expect(result.attention).toEqual([]);
    // The put-back wrote the live row's own ID, never the retired one.
    expect(writes.flat().map((w) => w.value)).not.toContain(RETIRED);
    const ids = (await source.readColumn(ref, 1, "Knit ID")).map(
      (c) => c.value,
    );
    expect(ids).toEqual(["", LIVE, RETIRED]);
    expect(result.rows.map((r) => [r.rowNumber, knitIdOf(r)])).toEqual([
      [3, LIVE],
    ]);
  });
});
