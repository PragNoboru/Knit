import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TrackerConfig } from "@/lib/domain/config";
import {
  renderKnitNote,
  type NoteTask,
  type NoteTaskDay,
} from "@/lib/domain/note";
import { aliasMap, assigneesFor, splitOwners } from "@/lib/domain/owners";
import {
  heldSourceStatus,
  mapSourceStatus,
  writeBackFor,
} from "@/lib/domain/status";
import { renderTemplate } from "@/lib/domain/templates";

const trackers = (
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL("../../fixtures/trackers.config.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { trackers: Record<string, unknown>[] }
).trackers;
const configOf = (name: string) =>
  TrackerConfig.parse(trackers.find((t) => t.name === name));
const googleAds = configOf("Filing Buddy · Google Ads");
const noboru = configOf("Noboru · CA Campaign");

describe("tracker configs (PRD 8.2)", () => {
  it("the fixture configs of all four trackers are valid registries", () => {
    for (const t of trackers) {
      const result = TrackerConfig.safeParse(t);
      expect(result.success, String(t.name)).toBe(true);
    }
  });
});

describe("status mapping (PRD 6.8, N8)", () => {
  it("maps source words, normalised", () => {
    expect(mapSourceStatus("  In Progress ", googleAds)).toMatchObject({
      status: "in_progress",
      mapped: true,
    });
    expect(mapSourceStatus("Skipped", googleAds)).toMatchObject({
      status: "cancelled",
      mapped: true,
    });
  });

  it("maps a blank cell through the blank key", () => {
    expect(mapSourceStatus("", noboru)).toMatchObject({
      status: "yet_to_start",
      mapped: true,
      key: "",
    });
    expect(mapSourceStatus(null, noboru)).toMatchObject({
      status: "yet_to_start",
      mapped: true,
    });
  });

  it("treats an unmapped word as Yet to Start, never Done", () => {
    expect(mapSourceStatus("Copy ready", googleAds)).toMatchObject({
      status: "yet_to_start",
      mapped: false,
      key: "copy ready",
    });
  });

  it("carries cancel reasons (Noboru Moved, N5)", () => {
    expect(mapSourceStatus("Moved", noboru)).toMatchObject({
      status: "cancelled",
      cancelReason: "Moved in source",
    });
  });

  it("gives write-back words; null leaves the cell alone, empty clears it", () => {
    expect(writeBackFor("done", googleAds)).toBe("Done");
    expect(writeBackFor("in_progress", noboru)).toBeNull();
    expect(writeBackFor("yet_to_start", noboru)).toBe("");
  });
});

describe("heldSourceStatus: a word the row still shows keeps its recorded status (N28, N60)", () => {
  // "Done" remapped to In Progress after Knit read it as Done.
  const remapped = TrackerConfig.parse({
    ...googleAds,
    statusMap: { ...googleAds.statusMap, done: "in_progress" },
  });
  const read = mapSourceStatus("Done", remapped);

  it("returns the recorded status when the word is the snapshot's and a status is recorded", () => {
    expect(
      heldSourceStatus(
        read,
        { statusKey: "done", status: "done", completedOn: null },
        remapped,
      ),
    ).toEqual({
      status: "done",
      mapped: true,
      key: "done",
      cancelReason: null,
    });
  });

  it("returns the current reading when the word differs, the status is null or absent, or there is no snapshot", () => {
    for (const snapshot of [
      { statusKey: "in progress", status: "in_progress" as const },
      { statusKey: "done", status: null },
      { statusKey: "done" },
      null,
    ]) {
      const held = heldSourceStatus(
        read,
        snapshot && { ...snapshot, completedOn: null },
        remapped,
      );
      expect(held).toBe(read);
    }
  });

  it("reads a word removed from the map as unmapped, even beside a recorded Done (invariant 7, N34)", () => {
    const statusMap = Object.fromEntries(
      Object.entries(googleAds.statusMap).filter(([word]) => word !== "done"),
    );
    const removed = TrackerConfig.parse({ ...googleAds, statusMap });
    const unmapped = mapSourceStatus("Done", removed);
    expect(unmapped.mapped).toBe(false);
    expect(
      heldSourceStatus(
        unmapped,
        { statusKey: "done", status: "done", completedOn: "2026-09-28" },
        removed,
      ),
    ).toBe(unmapped);
  });

  it("gives a recorded Cancelled its word's configured reason, or null when the config has none", () => {
    const moved = { statusKey: "moved", status: "cancelled" as const };
    const remappedMoved = TrackerConfig.parse({
      ...noboru,
      statusMap: { ...noboru.statusMap, moved: "yet_to_start" },
      cancelReasons: {},
    });
    expect(
      heldSourceStatus(
        mapSourceStatus("Moved", noboru),
        { ...moved, completedOn: null },
        noboru,
      ),
    ).toMatchObject({ status: "cancelled", cancelReason: "Moved in source" });
    expect(
      heldSourceStatus(
        mapSourceStatus("Moved", remappedMoved),
        { ...moved, completedOn: null },
        remappedMoved,
      ),
    ).toEqual({
      status: "cancelled",
      mapped: true,
      key: "moved",
      cancelReason: null,
    });
  });
});

describe("owners (PRD 6.7, N3)", () => {
  const PRAGAMAN = "user-pragaman";
  const aliases = aliasMap([
    { aliasNorm: "pragaman", userId: PRAGAMAN },
    { aliasNorm: "p", userId: PRAGAMAN },
    { aliasNorm: "agent", userId: null },
    { aliasNorm: "shlok", userId: null },
    { aliasNorm: "anjan", userId: null },
  ]);

  it("splits on the tracker's separators", () => {
    expect(splitOwners("P + Agent", [",", "+"])).toEqual(["p", "agent"]);
    expect(splitOwners("Anjan, Shlok, Pragaman", [","])).toEqual([
      "anjan",
      "shlok",
      "pragaman",
    ]);
  });

  it("assigns matching users, ignores known non-users, reports unknown names", () => {
    expect(assigneesFor("P + Agent", googleAds, aliases, null)).toEqual({
      userIds: [PRAGAMAN],
      unknown: [],
    });
    expect(
      assigneesFor("Anjan, Shlok, Pragaman", noboru, aliases, null),
    ).toEqual({ userIds: [PRAGAMAN], unknown: [] });
    expect(assigneesFor("Creative", googleAds, aliases, null)).toEqual({
      userIds: [],
      unknown: ["creative"],
    });
  });

  it("assigns every task to the tracker owner when there is no owner column", () => {
    const noOwner = {
      ...googleAds,
      columns: { ...googleAds.columns, owner: null },
    };
    expect(assigneesFor("anything", noOwner, aliases, "owner-1")).toEqual({
      userIds: ["owner-1"],
      unknown: [],
    });
  });
});

describe("templates (PRD 8.2)", () => {
  const row: Record<string, string> = {
    "asset id": "REEL-01",
    "working title": "Bring one neighbour",
    id: "G01",
  };
  const lookup = (header: string) => row[header];

  it("renders fields with their separators", () => {
    expect(renderTemplate("{Asset ID} · {Working title}", lookup)).toBe(
      "REEL-01 · Bring one neighbour",
    );
  });

  it("collapses the separator next to a missing value", () => {
    expect(renderTemplate("{ID} · {Phase}", lookup)).toBe("G01");
    expect(renderTemplate("{Phase} · {ID}", lookup)).toBe("G01");
    expect(renderTemplate("{Phase} · {Type}", lookup)).toBe("");
  });
});

describe("renderKnitNote (PRD 6.9): every row of the table", () => {
  const TODAY = "2026-10-05";
  const task = (over: Partial<NoteTask>): NoteTask => ({
    status: "yet_to_start",
    statusReason: null,
    completedOn: null,
    dueDate: "2026-09-30",
    historyOnly: false,
    ...over,
  });
  const day = (
    d: string,
    spillIndex: number,
    locked: boolean,
    status: NoteTaskDay["status"] = "not_done",
  ): NoteTaskDay => ({
    day: d,
    spillIndex,
    locked,
    status,
  });
  const spilled = [
    day("2026-09-30", 0, true),
    day("2026-10-01", 1, true),
    day("2026-10-05", 2, false, "in_progress"),
  ];

  it.each<[string, NoteTask, NoteTaskDay[], string]>([
    [
      "open, never spilled",
      task({}),
      [day("2026-10-05", 0, false, "yet_to_start")],
      "",
    ],
    [
      "open, never spilled, in progress",
      task({ status: "in_progress" }),
      [day("2026-10-05", 0, false)],
      "In progress",
    ],
    [
      "open, never spilled, blocked",
      task({ status: "blocked", statusReason: "Waiting for GTM" }),
      [day("2026-10-05", 0, false)],
      "Blocked: Waiting for GTM",
    ],
    ["open, spilled", task({}), spilled, "Spilled 2x · now due Mon 5 Oct"],
    [
      "open, spilled, in progress",
      task({ status: "in_progress" }),
      spilled,
      "Spilled 2x · now due Mon 5 Oct · In progress",
    ],
    [
      "open, spilled, blocked",
      task({ status: "blocked", statusReason: "Agency" }),
      spilled,
      "Spilled 2x · now due Mon 5 Oct · Blocked: Agency",
    ],
    [
      "done on time",
      task({ status: "done", completedOn: "2026-09-30" }),
      [day("2026-09-30", 0, true, "done")],
      "Done on Wed 30 Sep",
    ],
    [
      "done after spills (PRD 6.4 example)",
      task({ status: "done", completedOn: "2026-10-05" }),
      [day("2026-10-05", 3, false, "done")],
      "Done on Mon 5 Oct · after 3 spills",
    ],
    [
      "done early",
      task({
        status: "done",
        completedOn: "2026-09-24",
        dueDate: "2026-09-30",
      }),
      [day("2026-09-30", 0, false, "done")],
      "Done early on Thu 24 Sep · planned Wed 30 Sep",
    ],
    [
      "cancelled",
      task({ status: "cancelled", statusReason: "Moved in source" }),
      [],
      "Cancelled: Moved in source",
    ],
    [
      "history only",
      task({ historyOnly: true, status: "in_progress" }),
      [],
      "Before Knit go-live",
    ],
  ])("%s", (_state, t, days, expected) => {
    expect(renderKnitNote(t, days, TODAY)).toBe(expected);
  });

  it("stays within 80 characters by shortening the reason", () => {
    const note = renderKnitNote(
      task({ status: "blocked", statusReason: "x".repeat(140) }),
      spilled,
      TODAY,
    );
    expect(note.length).toBe(80);
    expect(note.startsWith("Spilled 2x · now due Mon 5 Oct · Blocked: x")).toBe(
      true,
    );
  });

  it("counts the spills before the day it was done, not the task-days a correction cancelled (6.10)", () => {
    // G21 missed Wed 30 Sep and Thu 1 Oct; the admin corrects a day to Done, which cancels
    // every later task-day (spill_index kept) and sets Completed On to the corrected day.
    const chain = (doneOn: string): NoteTaskDay[] =>
      [
        day("2026-09-30", 0, true),
        day("2026-10-01", 1, true),
        day("2026-10-03", 2, true),
      ].map((d) =>
        d.day === doneOn
          ? { ...d, status: "done" }
          : d.day > doneOn
            ? { ...d, status: "cancelled" }
            : d,
      );
    expect(
      renderKnitNote(
        task({ status: "done", completedOn: "2026-09-30" }),
        chain("2026-09-30"),
        TODAY,
      ),
    ).toBe("Done on Wed 30 Sep");
    expect(
      renderKnitNote(
        task({ status: "done", completedOn: "2026-10-01" }),
        chain("2026-10-01"),
        TODAY,
      ),
    ).toBe("Done on Thu 1 Oct · after 1 spill");
  });

  describe("open, spilled: n is the open task-day's spill index (N62, amends N38)", () => {
    // G21 missed Wed 30 Sep, Thu 1 Oct and Sat 3 Oct and is open on Mon 5 Oct (spill 3). On
    // Mon 5 Oct the admin corrects Thu 1 Oct to Done by mistake: Sat 3 Oct and Mon 5 Oct are
    // cancelled by the correction (6.10), their spill indexes kept.
    const mistakenDone: NoteTaskDay[] = [
      day("2026-09-30", 0, true),
      day("2026-10-01", 1, true, "done"),
      day("2026-10-03", 2, true, "cancelled"),
      day("2026-10-05", 3, true, "cancelled"),
    ];

    it("Q6 undone the next day: the reopened task counts only its new task-day's spills", () => {
      // Tue 6 Oct: the admin corrects Thu 1 Oct back to In Progress. Its last task-day, Mon 5
      // Oct, is before today, so a task-day is added on today with the corrected task-day's
      // spill index plus one (2); the cancelled task-days keep 2 and 3 and never count.
      const undone: NoteTaskDay[] = [
        day("2026-09-30", 0, true),
        day("2026-10-01", 1, true, "in_progress"),
        day("2026-10-03", 2, true, "cancelled"),
        day("2026-10-05", 3, true, "cancelled"),
        day("2026-10-06", 2, false, "in_progress"),
      ];
      expect(
        renderKnitNote(task({ status: "in_progress" }), undone, "2026-10-06"),
      ).toBe("Spilled 2x · now due Tue 6 Oct · In progress");
      // While the mistaken Done stood, the Done note already ignored them (N38).
      expect(
        renderKnitNote(
          task({ status: "done", completedOn: "2026-10-01" }),
          mistakenDone,
          "2026-10-05",
        ),
      ).toBe("Done on Thu 1 Oct · after 1 spill");
    });

    it("Q6 undone the same day: the task-day reopened in place counts the corrected one's spills plus one", () => {
      // Mon 5 Oct, still the same day: Mon 5 Oct is today, so it reopens in place with the
      // corrected task-day's spill index plus one (2), not the 3 it had before.
      const undone: NoteTaskDay[] = [
        day("2026-09-30", 0, true),
        day("2026-10-01", 1, true, "yet_to_start"),
        day("2026-10-03", 2, true, "cancelled"),
        day("2026-10-05", 2, false, "yet_to_start"),
      ];
      expect(renderKnitNote(task({}), undone, TODAY)).toBe(
        "Spilled 2x · now due Mon 5 Oct",
      );
    });

    it("never takes a task-day a correction cancelled as the open one, locked or not", () => {
      const days: NoteTaskDay[] = [
        day("2026-09-30", 0, true),
        day("2026-10-01", 1, false, "in_progress"),
        day("2026-10-03", 4, false, "cancelled"),
      ];
      expect(
        renderKnitNote(task({ status: "in_progress" }), days, "2026-10-01"),
      ).toBe("Spilled 1x · now due Thu 1 Oct · In progress");
    });

    it("an open task with no open task-day shows only its status", () => {
      expect(
        renderKnitNote(
          task({ status: "blocked", statusReason: "Agency" }),
          [day("2026-09-30", 0, true), day("2026-10-01", 1, true)],
          TODAY,
        ),
      ).toBe("Blocked: Agency");
    });
  });
});
