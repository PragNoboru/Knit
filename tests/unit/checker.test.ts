import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { ownerLine, TaskCard } from "@/lib/domain/cards";
import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import { aliasMap, assigneesFor } from "@/lib/domain/owners";
import {
  contentHeaders,
  isEmptyRow,
  normaliseRow,
  type SheetRow,
} from "@/lib/domain/rows";
import {
  CHECKER_NEEDS_OWNER,
  CHECKER_SAME_AS_OWNER,
  draftProblems,
  finalConfig,
  previewPeople,
  previewPeopleHeads,
  writeTargetProblem,
  type DraftConfig,
} from "@/lib/domain/wizard";
import {
  columnLetter,
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type TabStructure,
} from "@/lib/sheets/types";
import { detailPairs, ownerFacts } from "@/lib/domain/tasks-screens";
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
const registry = read<{ trackers: { name: string }[] }>("trackers.config.json");
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

  it("keeps an owner cell that names nobody as blank, so the drawer's Maker is who is assigned", () => {
    // Review of N73, N75: "," names nobody, so the Owner is assigned and is shown as Maker.
    for (const maker of [",", " , ", ", ,"]) {
      const normalised = normaliseRow(
        row({ ...base, Owner: "Pragaman", Maker: maker }),
        ctx(withChecker),
      );
      expect(normalised.assignees, maker).toEqual([PRAGAMAN]);
      expect(normalised.ownerRaw, maker).toBe(null);
      expect(
        ownerFacts({
          ownerRaw: normalised.ownerRaw,
          card: {
            checker: { header: "Owner", raw: normalised.details.Owner! },
          },
        }),
      ).toEqual([
        { label: "Owner", value: "Pragaman" },
        { label: "Maker", value: "Pragaman" },
      ]);
    }
    // Without a checker column the owner cell's text is kept as it was.
    expect(normaliseRow(row({ ...base, Owner: "," }), ctx(v1)).ownerRaw).toBe(
      ",",
    );
    expect(
      normaliseRow(row({ ...base, Owner: "P + Agent" }), ctx(v1)).ownerRaw,
    ).toBe("P + Agent");
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
      checkStructure(structure([...V2, "Owner", ...knit]), withChecker)?.reason,
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
    expect(writeTargetProblem({ ...columns, checker: "maker" }, "{Task}")).toBe(
      CHECKER_SAME_AS_OWNER,
    );
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

describe("a checking owner needs an owner column (11 step 4, 12.8, N73)", () => {
  const columns = withChecker.columns;

  it("refuses a checker with No owner column, at step 4 and at activation", () => {
    expect(writeTargetProblem({ ...columns, owner: null }, "{Task}")).toBe(
      CHECKER_NEEDS_OWNER,
    );
    expect(CHECKER_NEEDS_OWNER).toBe(
      "Choose the Who does the task column to use a checking owner.",
    );
    expect(
      draftProblems({
        ...withChecker,
        columns: { ...columns, owner: null },
      }),
    ).toContainEqual({ step: "columns", problem: CHECKER_NEEDS_OWNER });
  });

  it("keeps No owner column without a checker, as before", () => {
    expect(
      writeTargetProblem({ ...columns, owner: null, checker: null }, "{Task}"),
    ).toBe(null);
    expect(writeTargetProblem({ ...v1.columns, owner: null }, "{Task}")).toBe(
      null,
    );
  });
});

describe("the wizard preview's people columns (11 step 8, N75)", () => {
  it("shows the owner cell as Owner without a checker, as before", () => {
    expect(previewPeopleHeads(null)).toEqual(["Owner"]);
    expect(previewPeople({ ownerRaw: "P + Agent", details: {} }, null)).toEqual(
      ["P + Agent"],
    );
    expect(previewPeople({ ownerRaw: null, details: {} }, null)).toEqual([""]);
  });

  it("shows Owner and Maker as the drawer does with a checker", () => {
    expect(previewPeopleHeads("Owner")).toEqual(["Owner", "Maker"]);
    const preview = (owner: string, maker: string) => {
      const normalised = normaliseRow(
        row({
          Date: "1 Oct 2026",
          Task: "Sign off the launch budget",
          Status: "Not started",
          Owner: owner,
          Maker: maker,
        }),
        ctx(withChecker),
      );
      return previewPeople(normalised, "Owner");
    };
    // NOB-03: the Maker's name is never shown as the Owner.
    expect(preview("Shlok", "Pragaman")).toEqual(["Shlok", "Pragaman"]);
    // A blank Maker: the Owner does it, and is who it is assigned to.
    expect(preview("Pragaman", "")).toEqual(["Pragaman", "Pragaman"]);
    expect(preview("Pragaman", ",")).toEqual(["Pragaman", "Pragaman"]);
    expect(preview("", "Pragaman, Shlok")).toEqual(["None", "Pragaman, Shlok"]);
  });
});

describe("showing the Owner (12.3, 12.6, N75)", () => {
  const card = {
    taskId: "00000000-0000-4000-8000-000000000001",
    title: "Approve the launch budget",
    subtitle: null,
    critical: false,
    dueDate: "2026-10-01",
    plannedStart: "2026-10-01",
    plannedEnd: null,
    plannedRaw: "Thu 1 Oct 2026",
    dateKind: "single",
    taskStatus: "yet_to_start",
    taskReason: null,
    completedOn: null,
    sourceRef: "FBG-03",
    rowHint: 4,
    historyOnly: false,
    removed: false,
    tracker: {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Standard v2",
      color: "teal",
      fileId: "file",
      gid: 0,
    },
    taskDay: null,
    sync: null,
    spillCount: 0,
    editable: true,
  };

  it("reads a card from a database before the migration as having no checker", () => {
    expect(TaskCard.parse(card).checker).toBe(null);
    expect(ownerLine(TaskCard.parse(card))).toBe(null);
  });

  it('shows "Owner: {names}" only when the checker cell is filled', () => {
    const parse = (raw: string | null) =>
      TaskCard.parse({ ...card, checker: { header: "Owner", raw } });
    expect(ownerLine(parse("Shlok"))).toBe("Owner: Shlok");
    expect(ownerLine(parse("Pragaman, Shlok"))).toBe("Owner: Pragaman, Shlok");
    expect(ownerLine(parse(null))).toBe(null);
  });

  it("lists Owner and Maker in the drawer with a checker, else the one Owner line", () => {
    const checker = (raw: string | null) => ({
      card: { checker: { header: "Owner", raw } },
    });
    expect(ownerFacts({ ...checker("Shlok"), ownerRaw: "Pragaman" })).toEqual([
      { label: "Owner", value: "Shlok" },
      { label: "Maker", value: "Pragaman" },
    ]);
    // A blank Maker: the Owner is the maker (N72).
    expect(ownerFacts({ ...checker("Pragaman"), ownerRaw: null })).toEqual([
      { label: "Owner", value: "Pragaman" },
      { label: "Maker", value: "Pragaman" },
    ]);
    expect(ownerFacts({ ...checker(null), ownerRaw: "Riya" })).toEqual([
      { label: "Owner", value: "None" },
      { label: "Maker", value: "Riya" },
    ]);
    expect(
      ownerFacts({ card: { checker: null }, ownerRaw: "P + Agent" }),
    ).toEqual([{ label: "Owner", value: "P + Agent" }]);
    expect(ownerFacts({ card: { checker: null }, ownerRaw: null })).toEqual([
      { label: "Owner", value: "None" },
    ]);
  });

  it("leaves the checker's text out of the drawer's details", () => {
    const detail = {
      details: { Workstream: "Admin", Owner: "Shlok", Notes: "Soon" },
      detailOrder: ["Workstream", "Notes"],
    };
    expect(
      detailPairs({
        ...detail,
        card: { checker: { header: "Owner", raw: "Shlok" } },
      }),
    ).toEqual([
      { label: "Workstream", value: "Admin" },
      { label: "Notes", value: "Soon" },
    ]);
    // Without a checker column, every detail is listed as before.
    expect(detailPairs({ ...detail, card: { checker: null } })).toHaveLength(3);
    expect(detailPairs(detail)).toHaveLength(3);
  });
});
