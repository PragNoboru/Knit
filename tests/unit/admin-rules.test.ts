import { describe, expect, it } from "vitest";

import {
  attentionRow,
  describeAttention,
  groupAttention,
} from "@/lib/domain/attention";
import { TrackerConfig } from "@/lib/domain/config";
import { planKnitIdRecreate } from "@/lib/domain/knit-id-recreate";
import type { PlanTask } from "@/lib/domain/planPull";
import type { SheetRow } from "@/lib/domain/rows";

// PRD 12.8 (Needs Attention) and 14 (a deleted Knit ID column): the admin screens' rules.

describe("Needs Attention texts (12.8)", () => {
  it("says what happened for each kind", () => {
    expect(describeAttention("unmapped_status", { word: "Copy ready" })).toBe(
      'The status "Copy ready" is not mapped, so its rows count as Yet to Start.',
    );
    expect(
      describeAttention("bad_date", {
        row: 12,
        value: "Sat 28 Sep",
        reason: "weekday_mismatch",
      }),
    ).toBe(
      'The date "Sat 28 Sep" cannot be used: the weekday does not match the date.',
    );
    expect(
      describeAttention("conflict", { knit: "done", sheet: "Blocked" }),
    ).toBe('Knit says Done, the sheet says "Blocked". Knit\'s value was kept.');
    expect(
      describeAttention("past_date_added", { dueDate: "2026-09-24" }),
    ).toBe(
      "Added with a due date already past (Thu 24 Sep), so it starts today as a spillover.",
    );
    expect(
      describeAttention("member_report", { text: "Done on Friday" }, "Shlok"),
    ).toBe('Shlok reported: "Done on Friday"');
    expect(describeAttention("missing_header", { header: "Status" })).toBe(
      'Column "Status" is not found. The tracker is paused.',
    );
  });

  it("says which rows to check when rows moved under a write", () => {
    expect(
      describeAttention("write_misplaced", {
        reason: "stray_write",
        row: 2,
        headers: ["Status", "Done on", "Knit Note"],
      }),
    ).toBe(
      "Rows moved while Knit was writing, so row 2 got values meant for another task (Status, Done on, Knit Note). Knit could not undo them: check that row.",
    );
    expect(
      describeAttention("write_misplaced", {
        reason: "unverified",
        rows: [2, 5],
      }),
    ).toBe(
      "Knit wrote to rows 2, 5 but could not read them back to check. If rows were moved just then, check those rows.",
    );
    expect(
      describeAttention("write_misplaced", { reason: "knit_id_lost", row: 35 }),
    ).toBe(
      "Rows moved while Knit was adding Knit IDs, and the Knit ID of row 35 could not be put back. Its task may show as removed and come back as a new one.",
    );
  });

  it("finds the row an item is about", () => {
    expect(attentionRow({ row: 7 }, 3)).toBe(7);
    expect(attentionRow({}, 3)).toBe(3);
    expect(attentionRow({}, null)).toBeNull();
  });

  it("groups by tracker, then kind", () => {
    const a = { id: "a", name: "A" };
    const groups = groupAttention([
      { kind: "bad_date", tracker: a },
      { kind: "unknown_owner", tracker: a },
      { kind: "bad_date", tracker: a },
      { kind: "calendar_ending", tracker: null },
    ]);
    expect(
      groups.map((g) => [
        g.tracker?.name ?? null,
        g.kinds.map((k) => [k.title, k.items.length]),
      ]),
    ).toEqual([
      [
        "A",
        [
          ["Date cannot be read", 2],
          ["Unknown owner", 1],
        ],
      ],
      [null, [["Calendar ending", 1]]],
    ]);
  });
});

describe("recreating the Knit ID column (14)", () => {
  const config = TrackerConfig.parse({
    headerRow: 1,
    columns: {
      date: "Date",
      title: "Task",
      statusRead: "Status",
      statusWrite: "Status",
      completedOn: null,
      owner: null,
      sourceRef: "ID",
      critical: null,
    },
    readOnlyColumns: [],
    titleTemplate: "{Task}",
    subtitleTemplate: null,
    detailColumns: [],
    statusMap: { "": "yet_to_start" },
    writeBack: {
      yet_to_start: null,
      in_progress: null,
      blocked: null,
      done: null,
      cancelled: null,
    },
    completedOnFormat: null,
  });
  const row = (
    n: number,
    id: string,
    task: string,
    date: string,
  ): SheetRow => ({
    rowNumber: n,
    cells: {
      id: { value: id, formatted: id },
      task: { value: task, formatted: task },
      date: { value: date, formatted: date },
    },
  });
  const task = (
    id: string,
    title: string,
    sourceRef: string | null,
    plannedRaw: string,
  ) =>
    ({
      id,
      title,
      sourceRef,
      plannedRaw,
      removedAtSource: false,
    }) as PlanTask;

  it("matches by source ID, else by title and planned date, and lists the rest", () => {
    const plan = planKnitIdRecreate(
      [
        row(2, "G01", "Remove the menu item", "Mon 28 Sep"),
        row(3, "", "Account assets", "Mon 28 Sep"),
        row(4, "", "Same title", "Tue 29 Sep"),
        row(5, "", "Same title", "Tue 29 Sep"),
        row(6, "G99", "A new row", "Wed 30 Sep"),
      ],
      [
        task("t1", "Renamed in the sheet since", "G01", "Mon 28 Sep"),
        task("t2", "Account assets", null, "Mon 28 Sep"),
        task("t3", "Same title", null, "Tue 29 Sep"),
        task("t4", "Deleted row", "G05", "Tue 29 Sep"),
      ],
      config,
    );
    expect(plan.matches).toEqual([
      {
        row: 2,
        taskId: "t1",
        title: "Renamed in the sheet since",
        rowTitle: "Remove the menu item",
        by: "source_id",
      },
      {
        row: 3,
        taskId: "t2",
        title: "Account assets",
        rowTitle: "Account assets",
        by: "title_and_date",
      },
    ]);
    // Two rows share "Same title" on 29 Sep: neither can be told apart, so both are new.
    expect(plan.newRows.map((r) => r.row)).toEqual([4, 5, 6]);
    expect(plan.missingTasks.map((t) => t.taskId)).toEqual(["t3", "t4"]);
  });
});
