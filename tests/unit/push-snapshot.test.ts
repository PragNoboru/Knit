import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TrackerConfig } from "@/lib/domain/config";
import type { SheetRow, SourceSnapshot } from "@/lib/domain/rows";
import type { CellWrite } from "@/lib/sheets/types";
import { cellsFor, writtenSnapshot } from "@/lib/sync/push";

// PRD 10.3, 10.4 step 5, N23: what a verified write-back records as the sheet's last known
// status. Only a status-read cell that holds Knit's own write is recorded.

const base = TrackerConfig.parse(
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
const TODAY = "2026-09-28";

const text = (v: string) => ({ value: v, formatted: v });
/** A row re-read after the write: Status (read) says Done, Notes (written) says In progress. */
const row: SheetRow = {
  rowNumber: 2,
  cells: {
    status: text("Done"),
    notes: text("In progress"),
    "knit note": text("In progress"),
  },
};
const cells = (statusHeader: string): CellWrite[] => [
  { row: 2, header: statusHeader, kind: "text", value: "In progress" },
  { row: 2, header: "Knit Note", kind: "text", value: "In progress" },
];
const withStatusWrite = (statusWrite: string) =>
  TrackerConfig.parse({
    ...base,
    columns: { ...base.columns, statusWrite },
  });

describe("writtenSnapshot (PRD 10.3, N23)", () => {
  it("records the status word when Knit wrote the status-read cell itself", () => {
    expect(writtenSnapshot(row, cells("Status"), base, TODAY)).toEqual({
      statusKey: "done",
      status: "done",
    });
  });

  it("leaves the status word out when the status-read column is one Knit does not write", () => {
    // The Done in Status was typed by a person; Knit wrote Notes. The next pull must see it.
    expect(
      writtenSnapshot(row, cells("Notes"), withStatusWrite("Notes"), TODAY),
    ).toBeNull();
  });

  it("records the status word when the status-read column is a formula of the written one (6.8)", () => {
    // Like Noboru's Status: a formula column recomputed from the cell Knit wrote.
    expect(
      writtenSnapshot(row, cells("Notes"), withStatusWrite("Notes"), TODAY, [
        "status",
      ]),
    ).toEqual({ statusKey: "done", status: "done" });
  });

  it("records status null when the written word is not in the status map (N28)", () => {
    const unmapped: SheetRow = {
      rowNumber: 2,
      cells: { status: text("Copy ready"), "knit note": text("") },
    };
    expect(writtenSnapshot(unmapped, cells("Status"), base, TODAY)).toEqual({
      statusKey: "copy ready",
      status: null,
    });
  });
});

describe("cellsFor: a revert clears Completed On only from a Done Knit read (N24, N28)", () => {
  // "Done" remapped to In Progress since Knit last read the row.
  const remapped = TrackerConfig.parse({
    ...base,
    statusMap: {
      ...base.statusMap,
      done: "in_progress",
      "in progress": "done",
    },
  });
  const revert = (
    snapshot: SourceSnapshot,
    config: TrackerConfig,
  ): CellWrite[] =>
    cellsFor(
      {
        outboxId: "1",
        payload: { status_value: "Not started", completed_on: null },
        attempts: 0,
        tracker: { id: "t", fileId: "f", sheetGid: 0, config: {} },
        task: {
          id: "a",
          status: "yet_to_start",
          statusReason: null,
          completedOn: null,
          dueDate: "2026-09-28",
          historyOnly: false,
          sourceSnapshot: snapshot,
          removedAtSource: false,
        },
        taskDays: [],
      },
      config,
      2,
      TODAY,
    );
  const clears = (written: CellWrite[]) =>
    written.some(
      (c) => c.header === base.columns.completedOn && c.value === "",
    );

  it("clears it when the recorded status is Done, though the word now maps to In Progress", () => {
    expect(
      clears(
        revert(
          { statusKey: "done", status: "done", completedOn: "2026-09-27" },
          remapped,
        ),
      ),
    ).toBe(true);
  });

  it("leaves it when the recorded status is In Progress, though the word now maps to Done", () => {
    expect(
      clears(
        revert(
          {
            statusKey: "in progress",
            status: "in_progress",
            completedOn: "2026-09-27",
          },
          remapped,
        ),
      ),
    ).toBe(false);
  });

  it("leaves it when the word was unmapped when read (recorded null)", () => {
    expect(
      clears(
        revert(
          { statusKey: "done", status: null, completedOn: "2026-09-27" },
          base,
        ),
      ),
    ).toBe(false);
  });

  it("uses the status map for a snapshot saved before the status was recorded", () => {
    const legacy = { statusKey: "done", completedOn: "2026-09-27" };
    expect(clears(revert(legacy, base))).toBe(true);
    expect(clears(revert(legacy, remapped))).toBe(false);
  });
});
