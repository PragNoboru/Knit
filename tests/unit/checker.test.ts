import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import { aliasMap, assigneesFor } from "@/lib/domain/owners";
import {
  contentHeaders,
  isEmptyRow,
  normaliseRow,
  type SheetRow,
} from "@/lib/domain/rows";
import {
  CHECKER_SAME_AS_OWNER,
  draftProblems,
  finalConfig,
  writeTargetProblem,
  type DraftConfig,
} from "@/lib/domain/wizard";
import {
  columnLetter,
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type TabStructure,
} from "@/lib/sheets/types";
import { checkStructure, mappedHeaders } from "@/lib/sync/structure";

// PRD 6.7, 8.2, N72, N73: the checking owner column. The owner column says who does the task
// (the Maker) and is who the task is assigned to; the checker column names who checks it (the
// Owner). A blank owner cell takes its assignees from the checker cell.

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;
const registry = read<{ trackers: { name: string }[] }>(
  "trackers.config.json",
);
const holidays = read<{ holidays: { date: string; name: string }[] }>(
  "holidays.json",
).holidays;
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31"),
);

const v1 = TrackerConfig.parse(
  registry.trackers.find((t) => t.name === "Knit Standard · Example"),
);
/** v1's mapping with Maker as the owner column and Owner as the checker (as v2 maps it). */
const withChecker = TrackerConfig.parse({
  ...v1,
  columns: { ...v1.columns, owner: "Maker", checker: "Owner" },
});

const PRAGAMAN = "user-pragaman";
const RIYA = "user-riya";
const aliases = aliasMap([
  { aliasNorm: "pragaman", userId: PRAGAMAN },
  { aliasNorm: "p", userId: PRAGAMAN },
  { aliasNorm: "riya", userId: RIYA },
  { aliasNorm: "shlok", userId: null },
]);

const text = (v: string) => ({ value: v, formatted: v });
function row(cells: Record<string, string>, rowNumber = 2): SheetRow {
  return {
    rowNumber,
    cells: Object.fromEntries(
      Object.entries(cells).map(([header, value]) => [
        normaliseKey(header),
        text(value),
      ]),
    ),
  };
}
const ctx = (config: TrackerConfig) => ({
  config,
  calendar,
  aliases,
  trackerOwnerId: "tracker-owner",
  today: "2026-09-25" as const,
  knitIdHeader: KNIT_ID_HEADER,
});

describe("the registry (8.2, N73)", () => {
  it("defaults the checker to null, so existing trackers read as before", () => {
    expect(v1.columns.checker).toBe(null);
    for (const tracker of registry.trackers.filter(
      (t) => t.name !== "Knit Standard v2 · Example",
    ))
      expect(TrackerConfig.parse(tracker).columns.checker, tracker.name).toBe(
        null,
      );
  });

  it("carries the checker into the final config, or null when none is chosen", () => {
    const draft: DraftConfig = { ...withChecker };
    expect(finalConfig(draft).data?.columns.checker).toBe("Owner");
    const none = finalConfig({
      ...draft,
      columns: { ...draft.columns, checker: undefined },
    });
    expect(none.data?.columns.checker).toBe(null);
  });
});

describe("assigneesFor with a checking owner column (6.7, N73)", () => {
  const assign = (
    owner: string,
    checker: string,
    config: TrackerConfig = withChecker,
  ) => assigneesFor(owner, config, aliases, "tracker-owner", checker);

  it("assigns by the owner cell alone when it names someone", () => {
    expect(assign("Pragaman", "Shlok")).toEqual({
      userIds: [PRAGAMAN],
      unknown: [],
    });
    // The checker is not assigned, and its unknown names are not looked up.
    expect(assign("Riya", "Pragaman, Nobody")).toEqual({
      userIds: [RIYA],
      unknown: [],
    });
    expect(assign("Pragaman, Riya", "Shlok")).toEqual({
      userIds: [PRAGAMAN, RIYA].sort(),
      unknown: [],
    });
  });

  it("assigns from the checker cell when the owner cell is blank", () => {
    expect(assign("", "Pragaman")).toEqual({
      userIds: [PRAGAMAN],
      unknown: [],
    });
    // A cell of separators only names nobody.
    expect(assign(" , ", "P, Riya")).toEqual({
      userIds: [PRAGAMAN, RIYA].sort(),
      unknown: [],
    });
    // Its unknown names are reported like the owner cell's (one item per name, 6.7).
    expect(assign("", "Pragaman, Nobody")).toEqual({
      userIds: [PRAGAMAN],
      unknown: ["nobody"],
    });
    expect(assign("", "")).toEqual({ userIds: [], unknown: [] });
  });

  it("keeps the owner filter: with all, the tracker owner gets every row", () => {
    const all = TrackerConfig.parse({ ...withChecker, ownerFilter: "all" });
    expect(assign("", "Riya", all)).toEqual({
      userIds: [RIYA, "tracker-owner"].sort(),
      unknown: [],
    });
  });

  it("without a checker column, a blank owner cell assigns nobody (as before)", () => {
    expect(assign("", "Pragaman", v1)).toEqual({ userIds: [], unknown: [] });
  });

  it("without an owner column, every task goes to the tracker owner", () => {
    const noOwner = TrackerConfig.parse({
      ...withChecker,
      columns: { ...withChecker.columns, owner: null },
    });
    expect(assign("", "Pragaman", noOwner)).toEqual({
      userIds: ["tracker-owner"],
      unknown: [],
    });
  });
});

describe("normaliseRow with a checking owner column (10.2 step 5, N73)", () => {
  const base = {
    "Task ID": "FBG-03",
    Date: "1 Oct 2026",
    Task: "Approve the launch budget",
    Workstream: "Admin",
    Status: "Not started",
  };

  it("keeps the checker's text in the details, under its header", () => {
    const normalised = normaliseRow(
      row({ ...base, Owner: "Shlok", Maker: "Pragaman" }),
      ctx(withChecker),
    );
    expect(normalised.assignees).toEqual([PRAGAMAN]);
    expect(normalised.ownerRaw).toBe("Pragaman");
    expect(normalised.details).toEqual({ Workstream: "Admin", Owner: "Shlok" });
  });

  it("assigns a blank Maker's row to the Owner, and leaves ownerRaw empty", () => {
    const normalised = normaliseRow(
      row({ ...base, Owner: "Pragaman", Maker: "" }),
      ctx(withChecker),
    );
    expect(normalised.assignees).toEqual([PRAGAMAN]);
    expect(normalised.ownerRaw).toBe(null);
    expect(normalised.details.Owner).toBe("Pragaman");
  });

  it("adds nothing when the checker cell is blank, or no checker is mapped", () => {
    expect(
      normaliseRow(row({ ...base, Maker: "Pragaman" }), ctx(withChecker))
        .details,
    ).toEqual({ Workstream: "Admin" });
    expect(
      normaliseRow(row({ ...base, Owner: "Pragaman" }), ctx(v1)).details,
    ).toEqual({ Workstream: "Admin" });
  });

  it("counts the checker as content (10.2 step 3, N51)", () => {
    expect(contentHeaders(withChecker)).toContain("Owner");
    expect(contentHeaders(v1)).not.toContain("Maker");
    expect(isEmptyRow(row({ Owner: "Pragaman" }), withChecker)).toBe(false);
    expect(isEmptyRow(row({ Maker: "Pragaman" }), v1)).toBe(true);
  });
});

describe("the structure check (10.2 step 2, N73)", () => {
  const V2 = [
    "Task ID",
    "Date",
    "End date",
    "Task",
    "Details / done when",
    "Workstream",
    "Owner",
    "Maker",
    "Priority",
    "Status",
    "Stage",
    "Done on",
    "Depends on",
    "Link",
    "Notes",
  ];
  function structure(headers: string[]): TabStructure {
    const normalised = headers.map(normaliseKey);
    return {
      headers: headers.map((header, index) => ({
        index,
        letter: columnLetter(index),
        header,
        normalised: normalised[index]!,
      })),
      formulaColumns: [],
      validations: {},
      duplicateHeaders: normalised.filter(
        (h, i) => normalised.indexOf(h) !== i,
      ),
    };
  }
  const knit = [KNIT_ID_HEADER, KNIT_NOTE_HEADER];

  it("maps the checker header", () => {
    expect(mappedHeaders(withChecker)).toContain("Owner");
    expect(mappedHeaders(withChecker)).toContain("Maker");
    expect(checkStructure(structure([...V2, ...knit]), withChecker)).toBe(null);
  });

  it("pauses when the checker column is missing or doubled", () => {
    const missing = V2.filter((h) => h !== "Owner");
    expect(
      checkStructure(structure([...missing, ...knit]), withChecker),
    ).toEqual({
      kind: "missing_header",
      dedupeKey: "missing_header:owner",
      reason: "column 'Owner' not found",
      detail: { header: "Owner" },
    });
    expect(
      checkStructure(structure([...V2, "Owner", ...knit]), withChecker)
        ?.reason,
    ).toBe("column 'Owner' appears more than once");
  });
});

describe("the wizard's column rules (11 step 4, 12.8, N42, N73)", () => {
  const columns = withChecker.columns;

  it("never lets the checker be a write target", () => {
    expect(writeTargetProblem(columns, "{Task}")).toBe(null);
    expect(
      writeTargetProblem({ ...columns, statusWrite: "Owner" }, "{Task}"),
    ).toBe(
      '"Owner" is the checking owner, which Knit never changes. Choose another column to write to.',
    );
    expect(
      writeTargetProblem({ ...columns, completedOn: "owner" }, "{Task}"),
    ).toMatch(/checking owner/);
  });

  it("refuses the owner column as the checker", () => {
    expect(
      writeTargetProblem({ ...columns, checker: "maker" }, "{Task}"),
    ).toBe(CHECKER_SAME_AS_OWNER);
    expect(CHECKER_SAME_AS_OWNER).toBe(
      "Who does the task and the checking owner must be different columns.",
    );
    expect(
      draftProblems({
        ...withChecker,
        columns: { ...columns, checker: "Maker" },
      }).map((p) => p.problem),
    ).toContain(CHECKER_SAME_AS_OWNER);
  });
});
