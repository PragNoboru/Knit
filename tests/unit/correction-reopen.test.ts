import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeAttention } from "@/lib/domain/attention";
import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import { renderKnitNote, type NoteTaskDay } from "@/lib/domain/note";
import { aliasMap } from "@/lib/domain/owners";
import {
  planPull,
  type PlanTask,
  type PlanTaskDay,
} from "@/lib/domain/planPull";
import { normaliseRow, type SheetRow } from "@/lib/domain/rows";
import { messageFor } from "@/lib/errors";

// PRD 6.10, N15, Q6 (resolved 1 Oct 2026) and 10.3: a correction reopens a finished task; the
// sheet reopening one is still a conflict the admin answers with that correction.

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;

const config = TrackerConfig.parse(
  read<{ trackers: Record<string, unknown>[] }>(
    "trackers.config.json",
  ).trackers.find((t) => t.name === "Filing Buddy · Google Ads"),
);
const calendar = calendarFromDays(
  calendarDaysFromRules(
    read<{ holidays: { date: string; name: string }[] }>("holidays.json")
      .holidays,
    "2026-01-01",
    "2027-12-31",
  ),
);
const ME = "user-pragaman";
const aliases = aliasMap([{ aliasNorm: "pragaman", userId: ME }]);
const TODAY = "2026-09-30";
const ctx = {
  trackerId: "tracker-1",
  goLiveDate: "2026-09-28",
  today: TODAY,
  config,
};

/** A Filing Buddy row planned on Tue 29 Sep. */
function row(
  knitId: string,
  over: { status?: string; doneOn?: string } = {},
): SheetRow {
  const text = (v: string) => ({ value: v, formatted: v });
  return {
    rowNumber: 2,
    cells: {
      id: text("G21"),
      date: text("Tue 29 Sep"),
      phase: text("Launch"),
      task: text("Publish the staged pages"),
      owner: text("Pragaman"),
      status: text(over.status ?? "Not started"),
      "done on": text(over.doneOn ?? ""),
      "knit id": text(knitId),
    },
  };
}

const normalise = (r: SheetRow) =>
  normaliseRow(r, {
    config,
    calendar,
    aliases,
    trackerOwnerId: null,
    today: TODAY,
    knitIdHeader: "Knit ID",
  });

function taskDay(
  id: string,
  day: string,
  over: Partial<PlanTaskDay> = {},
): PlanTaskDay {
  return {
    id,
    day,
    status: "yet_to_start",
    spillIndex: 0,
    origin: "planned",
    reason: null,
    locked: false,
    ...over,
  };
}

/** Done on Tue 29 Sep, written to the sheet, and Tue 29 Sep closed. */
function doneTask(id: string, over: Partial<PlanTask> = {}): PlanTask {
  const r = normalise(row(id, { status: "Done", doneOn: "Tue 29 Sep" }));
  return {
    id,
    title: r.title,
    subtitle: r.subtitle,
    details: r.details,
    sourceRef: r.sourceRef,
    critical: r.critical,
    ownerRaw: r.ownerRaw,
    plannedRaw: r.plannedRaw,
    rowHint: r.rowNumber,
    dateKind: "single",
    plannedStart: "2026-09-29",
    plannedEnd: null,
    dueDate: "2026-09-29",
    status: "done",
    statusReason: null,
    sourceStatusRaw: r.statusRaw,
    completedOn: "2026-09-29",
    historyOnly: false,
    removedAtSource: false,
    sourceSnapshot: r.snapshot,
    hubChanged: false,
    assignees: [ME],
    taskDays: [taskDay("td-1", "2026-09-29", { status: "done", locked: true })],
    ...over,
  };
}

const plan = (tasks: PlanTask[], rows: SheetRow[]) =>
  planPull(tasks, rows.map(normalise), ctx);

describe("planPull: the sheet reopens a finished task (PRD 10.3, 6.10)", () => {
  it("is not applied: one reopened_in_source conflict, no task-day, status or snapshot change", () => {
    const p = plan(
      [doneTask("a")],
      [row("a", { status: "In progress", doneOn: "" })],
    );
    expect(p.attention).toEqual([
      expect.objectContaining({
        kind: "conflict",
        dedupeKey: "conflict:a",
        detail: expect.objectContaining({
          reason: "reopened_in_source",
          knit: "done",
          source: "in_progress",
          sourceWord: "In progress",
        }),
      }),
    ]);
    expect(p.stats.conflicts).toBe(1);
    expect(p.taskDayInserts).toEqual([]);
    expect(p.taskDayUpdates).toEqual([]);
    expect(p.outbox).toEqual([]);
    for (const update of p.taskUpdates) {
      expect(update.set).not.toHaveProperty("status");
      expect(update.set).not.toHaveProperty("sourceSnapshot");
    }
  });

  it("once a correction reopened it, another word is a plain conflict and Knit's status is queued again", () => {
    const reopened = doneTask("a", {
      status: "in_progress",
      completedOn: null,
      hubChanged: true,
      taskDays: [
        taskDay("td-1", "2026-09-29", { status: "in_progress", locked: true }),
        taskDay("td-2", TODAY, {
          status: "in_progress",
          spillIndex: 1,
          origin: "spillover",
        }),
      ],
    });
    const p = plan([reopened], [row("a", { status: "Blocked" })]);
    expect(p.attention).toEqual([
      expect.objectContaining({ kind: "conflict", dedupeKey: "conflict:a" }),
    ]);
    expect(p.attention[0]!.detail).not.toHaveProperty("reason");
    expect(p.outbox).toEqual([
      { taskId: "a", statusValue: "In progress", completedOn: null },
    ]);
    expect(p.taskDayInserts).toEqual([]);
  });
});

describe("copy for a finished task (PRD 6.10, 10.3, 12.6)", () => {
  it("the conflict tells the admin to correct the day the task ended", () => {
    expect(
      describeAttention("conflict", {
        reason: "reopened_in_source",
        knit: "done",
        source: "in_progress",
        sourceWord: "In progress",
      }),
    ).toBe(
      'The sheet reopened a task Knit has closed ("In progress"). Knit kept Done. To reopen it, correct the day it ended in the task drawer.',
    );
  });

  it("a refused correction says how to reopen a finished task", () => {
    expect(messageFor({ message: "correction_would_orphan_task" })).toBe(
      "This correction would leave the task with no open day. To reopen a finished task, correct the day it ended.",
    );
  });
});

describe("Knit Note of a task reopened by correction (PRD 6.9, N38)", () => {
  const day = (
    d: string,
    spillIndex: number,
    locked: boolean,
    status: NoteTaskDay["status"],
  ): NoteTaskDay => ({ day: d, spillIndex, locked, status });
  const base = {
    statusReason: null,
    dueDate: "2026-10-03",
    historyOnly: false,
  };

  it("reads as one spill while open, and after 1 spill once done", () => {
    expect(
      renderKnitNote(
        { ...base, status: "in_progress", completedOn: null },
        [
          day("2026-10-03", 0, true, "in_progress"),
          day("2026-10-05", 1, false, "in_progress"),
        ],
        "2026-10-05",
      ),
    ).toBe("Spilled 1x · now due Mon 5 Oct · In progress");
    expect(
      renderKnitNote(
        { ...base, status: "done", completedOn: "2026-10-05" },
        [
          day("2026-10-03", 0, true, "in_progress"),
          day("2026-10-05", 1, false, "done"),
        ],
        "2026-10-05",
      ),
    ).toBe("Done on Mon 5 Oct · after 1 spill");
  });
});
