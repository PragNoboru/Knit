import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ATTENTION_TITLES,
  describeAttention,
  groupAttention,
} from "@/lib/domain/attention";
import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import {
  KNIT_STANDARD_V1,
  KNIT_STANDARD_V2,
  matchStandardTemplate,
  standardSetupDraft,
} from "@/lib/domain/standard-template";
import {
  capTaskId,
  checkTrackerRequest,
  findingLines,
  findTasksTab,
  listOf,
  refusalText,
  requestDryRun,
  requestLine,
  requestStateText,
  sentDay,
  sentLines,
  sheetFileId,
  type RequestCheck,
  type RequestRefusal,
} from "@/lib/domain/tracker-request";
import {
  finalConfig,
  statusChoices,
  wizardStructure,
  writeBackOptions,
} from "@/lib/domain/wizard";
import {
  MemorySheetSource,
  type MemoryCell,
  type MemoryFile,
  type MemoryTab,
} from "@/lib/sheets/memory";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD N83 to N87, 12.9: the checks Knit makes on a sheet a person sends the admin, and every
// sentence they read. Over the two standard examples and variants of the v2 example.

const FIXTURES = loadXlsxFolder(
  fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
);
const registry = (
  await import("../../fixtures/trackers.config.json", {
    with: { type: "json" },
  })
).default as {
  referenceToday: string;
  people: { alias: string; user: string | null }[];
};
const holidays = (
  await import("../../fixtures/holidays.json", { with: { type: "json" } })
).default.holidays;
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31"),
);
const aliases = aliasMap(
  registry.people.map((p) => ({
    aliasNorm: normaliseKey(p.alias),
    userId: p.user === null ? null : `user-${normaliseKey(p.alias)}`,
  })),
);
const TODAY = registry.referenceToday;

const V2 = "Knit_Standard_Tracker_v2_example";
const V1 = "Knit_Standard_Tracker_v1_example";

/** A deep copy of a fixture file, to change without touching the others. */
const copyOf = (id: string): MemoryFile =>
  structuredClone(FIXTURES.find((f) => f.id === id)!);

const tasksTab = (file: MemoryFile): MemoryTab =>
  file.tabs.find((t) => t.title === "Tasks")!;

/** The 0-based column of a header in row 1. */
const column = (tab: MemoryTab, header: string) =>
  tab.rows[0]!.findIndex(
    (cell) => normaliseKey(cell.formatted) === normaliseKey(header),
  );

/** Sets a cell of the Tasks tab as a person typing text would. */
function setCell(
  file: MemoryFile,
  row: number,
  header: string,
  text: string,
  extra: Partial<MemoryCell> = {},
) {
  const tab = tasksTab(file);
  const col = column(tab, header);
  expect(col, header).toBeGreaterThanOrEqual(0);
  const cells = tab.rows[row - 1]!;
  while (cells.length <= col) cells.push({ value: null, formatted: "" });
  cells[col] = {
    value: text === "" ? null : text,
    formatted: text,
    ...extra,
  };
}

async function check(file: MemoryFile): Promise<RequestCheck> {
  const source = new MemorySheetSource([file]);
  const tab = findTasksTab(await source.listTabs(file.id))!;
  const ref = { fileId: file.id, sheetId: tab.sheetId };
  return checkTrackerRequest({
    rawStructure: await source.readStructure(ref, 1),
    rows: await source.readRows(ref, 1),
    today: TODAY,
    calendar,
    aliases,
  });
}

const findingsOf = (result: RequestCheck) =>
  result.kind === "findings" ? result.findings : [];

describe("the link (N84, N80)", () => {
  it("takes every link N80 takes, the account part included", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-ab";
    for (const link of [
      `https://docs.google.com/spreadsheets/d/${id}`,
      `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`,
      `https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`,
      `https://docs.google.com/spreadsheets/u/1/d/${id}/edit`,
      `  https://docs.google.com/spreadsheets/u/0/d/${id}  `,
    ])
      expect(sheetFileId(link), link).toBe(id);
    // The example trackers' ids in local sheet mode (N16).
    for (const name of [V2, "Sapiens_Example_Tracker"])
      expect(
        sheetFileId(`https://docs.google.com/spreadsheets/d/${name}/edit`),
      ).toBe(name);
  });

  it("refuses published links, other hosts, http and short ids", () => {
    for (const link of [
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vSomethingPublished/pubhtml",
      "https://example.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWx",
      "http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWx",
      "https://docs.google.com/spreadsheets/d/short",
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWx/edit",
      "",
      "not a link",
    ])
      expect(sheetFileId(link), link).toBeNull();
  });
});

describe("the Tasks tab (N84)", () => {
  it("is found by its title, normalised", () => {
    const tab = (title: string) => ({ title });
    expect(findTasksTab([tab("Summary"), tab("Tasks")])).toEqual(tab("Tasks"));
    expect(findTasksTab([tab(" tasks ")])).toEqual(tab(" tasks "));
    expect(findTasksTab([tab("TASKS")])).toEqual(tab("TASKS"));
    expect(findTasksTab([tab("Task list")])).toBeNull();
  });

  it("is missing from Sapiens_Example_Tracker, which has only Calendar", async () => {
    const source = new MemorySheetSource([copyOf("Sapiens_Example_Tracker")]);
    expect(
      findTasksTab(await source.listTabs("Sapiens_Example_Tracker")),
    ).toBeNull();
  });
});

describe("the standard examples (N84)", () => {
  it("the v2 example is ready: 10 tasks, no unknown names", async () => {
    const result = await check(copyOf(V2));
    expect(result).toEqual({
      kind: "ready",
      template: KNIT_STANDARD_V2,
      taskCount: 10,
      unknownNameRows: [],
      unknownNames: 0,
    });
  });

  it("the v1 example is ready in the v1 layout", async () => {
    const result = await check(copyOf(V1));
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.template.id).toBe(KNIT_STANDARD_V1.id);
      expect(result.taskCount).toBe(10);
    }
  });

  it("the Noboru tracker is refused: row 1 is not the template's", async () => {
    expect(await check(copyOf("Noboru_CA_Campaign_test_example"))).toEqual({
      kind: "refused",
      refusal: "not_template",
    });
  });

  it("reads with the config Use the standard setup would save (no drift)", async () => {
    for (const id of [V2, V1]) {
      const file = copyOf(id);
      const source = new MemorySheetSource([file]);
      const ref = { fileId: id, sheetId: tasksTab(file).sheetId };
      const structure = wizardStructure(await source.readStructure(ref, 1));
      const rows = await source.readRows(ref, 1);
      // As applyStandardSetup feeds it (lib/actions/admin.ts).
      const match = matchStandardTemplate(structure);
      if (!match || match.problem !== null) throw new Error("no match");
      const status = match.headers[normaliseKey("Status")] ?? "Status";
      const dropdown =
        structure.validations[normaliseKey(status)]?.options ?? null;
      const { patch } = standardSetupDraft(
        match,
        structure,
        statusChoices(rows, status, dropdown),
        writeBackOptions(rows, status, dropdown),
      );
      const saved = finalConfig(patch);
      expect(saved.success).toBe(true);
      expect(requestDryRun(match, structure, rows).config).toEqual(saved.data);
    }
  });
});

describe("variants of the v2 example (N84)", () => {
  it("an unreadable Date, an End date before its Date and a date outside the calendar are bad dates", async () => {
    const file = copyOf(V2);
    setCell(file, 2, "Date", "someday soon");
    setCell(file, 5, "End date", "Fri 2 Oct 2026");
    setCell(file, 9, "Date", "Mon 3 Jan 2028");
    expect(findingsOf(await check(file))).toEqual([
      { kind: "bad_dates", rows: [2, 5, 9] },
    ]);
  });

  it("an empty Date on a task is a bad date too", async () => {
    const file = copyOf(V2);
    setCell(file, 4, "Date", "");
    expect(findingsOf(await check(file))).toEqual([
      { kind: "bad_dates", rows: [4] },
    ]);
  });

  it("a blank Task ID, and one used twice in another spelling", async () => {
    const file = copyOf(V2);
    setCell(file, 4, "Task ID", "");
    setCell(file, 3, "Task ID", "nob-01");
    expect(findingsOf(await check(file))).toEqual([
      { kind: "no_task_id", rows: [4] },
      {
        kind: "duplicate_task_ids",
        rows: [2, 3],
        ids: [{ id: "NOB-01", rows: [2, 3] }],
      },
    ]);
  });

  it("a status word outside the five is found; a blank Status is not", async () => {
    const file = copyOf(V2);
    setCell(file, 3, "Status", "Waiting");
    expect(findingsOf(await check(file))).toEqual([
      { kind: "status_words", rows: [3] },
    ]);
  });

  it("a Status list without Cancelled, or with another word, is found", async () => {
    const without = copyOf(V2);
    const tab = tasksTab(without);
    const statusColumn = column(tab, "Status");
    const rule = tab.validations.find((v) => v.column === statusColumn)!;
    rule.options = rule.options!.filter((o) => o !== "Cancelled");
    expect(findingsOf(await check(without))).toEqual([
      { kind: "status_list", rows: [] },
    ]);
    const extra = copyOf(V2);
    const extraTab = tasksTab(extra);
    extraTab.validations
      .find((v) => v.column === column(extraTab, "Status"))!
      .options!.push("On hold");
    expect(findingsOf(await check(extra))).toEqual([
      { kind: "status_list", rows: [] },
    ]);
  });

  it("only empty rows is no tasks", async () => {
    const file = copyOf(V2);
    const tab = tasksTab(file);
    tab.rows = [
      tab.rows[0]!,
      ...tab.rows
        .slice(1)
        .map((row) => row.map(() => ({ value: null, formatted: "" }))),
    ];
    expect(findingsOf(await check(file))).toEqual([
      { kind: "no_tasks", rows: [] },
    ]);
  });

  it("an unknown Maker does not block: its row is named", async () => {
    const file = copyOf(V2);
    setCell(file, 2, "Maker", "Zed");
    expect(await check(file)).toMatchObject({
      kind: "ready",
      taskCount: 10,
      unknownNameRows: [2],
      unknownNames: 1,
    });
  });

  it("counts names, not rows: one unknown Maker on 3 rows is 1 name, two on one row are 2 (N86)", async () => {
    const file = copyOf(V2);
    for (const row of [2, 5, 7]) setCell(file, row, "Maker", "Riya");
    const once = await check(file);
    expect(once).toMatchObject({
      kind: "ready",
      unknownNameRows: [2, 5, 7],
      unknownNames: 1,
    });
    if (once.kind !== "ready") throw new Error("not ready");
    // The admin's line counts names; the person's line names every row.
    expect(
      describeAttention("tracker_request", {
        fileName: "Brand Zeta",
        taskCount: once.taskCount,
        templateId: once.template.id,
        unknownNames: once.unknownNames,
      }),
    ).toContain(" 1 name in it is not known to Knit yet.");
    expect(
      sentLines({
        fileName: "Brand Zeta",
        taskCount: once.taskCount,
        template: once.template,
        unknownNameRows: once.unknownNameRows,
      })[1],
    ).toBe(
      "Rows 2, 5, 7 name people Knit does not know yet. The admin links them when connecting the sheet.",
    );

    const two = copyOf(V2);
    setCell(two, 3, "Maker", "Riya + Zed");
    setCell(two, 6, "Maker", "riya");
    expect(await check(two)).toMatchObject({
      kind: "ready",
      unknownNameRows: [3, 6],
      unknownNames: 2,
    });
  });

  it("a Knit ID or Knit Note header in row 1 is refused before matching", async () => {
    for (const header of ["Knit ID", "Knit Note"]) {
      const file = copyOf(V2);
      tasksTab(file).rows[0]!.push({ value: header, formatted: header });
      expect(await check(file)).toEqual({
        kind: "refused",
        refusal: "knit_columns",
      });
    }
  });

  it("a formula in Done on is refused, naming the template's column", async () => {
    const file = copyOf(V2);
    setCell(file, 2, "Done on", "Mon 28 Sep 2026", { formula: "=TODAY()" });
    expect(await check(file)).toEqual({
      kind: "refused",
      refusal: "formula",
      header: "Done on",
    });
  });

  it("a renamed header is not the template's row 1", async () => {
    const file = copyOf(V2);
    const tab = tasksTab(file);
    tab.rows[0]![column(tab, "Task")] = { value: "Title", formatted: "Title" };
    expect(await check(file)).toEqual({
      kind: "refused",
      refusal: "not_template",
    });
  });
});

describe("what the person sees (N85)", () => {
  const CANARY = "CANARY";

  it("no sentence holds a cell of the sheet, but a capped Task ID", async () => {
    const file = copyOf(V2);
    const tab = tasksTab(file);
    const idColumn = column(tab, "Task ID");
    tab.rows = tab.rows.map((row, r) =>
      r === 0
        ? row
        : row.map((cell, c) =>
            c === idColumn
              ? { value: "NOB-01", formatted: "NOB-01" }
              : {
                  value: `${CANARY}-${r}-${c}`,
                  formatted: `${CANARY}-${r}-${c}`,
                },
          ),
    );
    const result = await check(file);
    expect(findingsOf(result).map((f) => f.kind)).toEqual([
      "bad_dates",
      "duplicate_task_ids",
      "status_words",
    ]);
    const lines = findingLines(findingsOf(result));
    expect(lines.join("\n")).not.toContain(CANARY);
    expect(lines.join("\n")).toContain("NOB-01 (rows 2, 3, 4");

    // Every other sentence, of every refusal and finding.
    const refusals: RequestRefusal[] = [
      "invalid_link",
      "note_too_long",
      "blank_template",
      "already_tracker",
      "setting_up",
      "archived",
      "already_requested",
      "limit",
      "not_in_folder",
      "not_a_sheet",
      "no_tasks_tab",
      "knit_columns",
      "not_template",
      "formula",
      "read_failed",
      "failed",
    ];
    for (const refusal of refusals)
      expect(refusalText(refusal, "Done on")).not.toContain(CANARY);
    const all = findingLines([
      { kind: "no_tasks", rows: [] },
      { kind: "bad_dates", rows: [2] },
      { kind: "no_task_id", rows: [3, 4] },
      { kind: "status_words", rows: [5] },
      { kind: "status_list", rows: [] },
    ]);
    expect(all.join("\n")).not.toContain(CANARY);
  });

  it("shows at most 40 characters of a Task ID used twice", async () => {
    const long = `${"X".repeat(150)}${CANARY}${"Y".repeat(44)}`;
    expect(long).toHaveLength(200);
    const file = copyOf(V2);
    setCell(file, 2, "Task ID", long);
    setCell(file, 3, "Task ID", long);
    const [line] = findingLines(findingsOf(await check(file)));
    expect(line).not.toContain(CANARY);
    expect(capTaskId(long)).toHaveLength(40);
    expect(line).toBe(
      `Task IDs used more than once: ${"X".repeat(39)}… (rows 2, 3).`,
    );
    expect(capTaskId("  NOB  01 ")).toBe("NOB 01");
  });

  it("lists at most 10 rows or IDs, then and {n} more", () => {
    const rows = Array.from({ length: 15 }, (_, i) => i + 2);
    expect(findingLines([{ kind: "no_task_id", rows }])).toEqual([
      "No Task ID: rows 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, and 5 more.",
    ]);
    expect(listOf(["a", "b"])).toBe("a, b");
    const ids = Array.from({ length: 12 }, (_, i) => ({
      id: `T-${i}`,
      rows: [i * 2 + 2, i * 2 + 3],
    }));
    const [line] = findingLines([
      { kind: "duplicate_task_ids", rows: [], ids },
    ]);
    expect(line).toMatch(/; T-9 \(rows 20, 21\), and 2 more\.$/);
    expect(line).not.toContain("T-10");
  });

  it("says each finding as 12.9 writes it", () => {
    expect(
      findingLines([
        { kind: "no_tasks", rows: [] },
        { kind: "bad_dates", rows: [7] },
        { kind: "bad_dates", rows: [3, 5] },
        { kind: "no_task_id", rows: [4] },
        {
          kind: "duplicate_task_ids",
          rows: [2, 3, 6, 8],
          ids: [
            { id: "NOB-01", rows: [2, 3] },
            { id: "NOB-04", rows: [6, 8] },
          ],
        },
        { kind: "status_words", rows: [9] },
        { kind: "status_list", rows: [] },
      ]),
    ).toEqual([
      "The Tasks tab has no tasks yet.",
      "Dates Knit cannot read or use: row 7.",
      "Dates Knit cannot read or use: rows 3, 5.",
      "No Task ID: row 4.",
      "Task IDs used more than once: NOB-01 (rows 2, 3); NOB-04 (rows 6, 8).",
      "A Status that is not one of the five words (Not started, In progress, Blocked, Done, Cancelled): row 9.",
      "The Status list was changed. Keep the template's five words: Not started, In progress, Blocked, Done, Cancelled.",
    ]);
    expect(refusalText("formula", "Status")).toBe(
      '"Status" holds formulas, so Knit could not write to it. Keep it as plain cells, as in the template.',
    );
  });

  it("says what was sent, with the rows naming people Knit does not know", () => {
    const sent = (rows: number[], taskCount = 10) =>
      sentLines({
        fileName: "Brand X",
        taskCount,
        template: KNIT_STANDARD_V2,
        unknownNameRows: rows,
      });
    expect(sent([])).toEqual([
      "Brand X: 10 tasks, in the Knit Standard Tracker v2 layout.",
    ]);
    expect(sent([4], 1)).toEqual([
      "Brand X: 1 task, in the Knit Standard Tracker v2 layout.",
      "Row 4 names someone Knit does not know yet. The admin links them when connecting the sheet.",
    ]);
    expect(sent([4, 6])[1]).toBe(
      "Rows 4, 6 name people Knit does not know yet. The admin links them when connecting the sheet.",
    );
  });

  it("dates a request in IST, whatever the machine's timezone (invariant 1)", () => {
    expect(process.env.TZ).toBe("UTC");
    expect(sentDay("2026-10-04T20:00:00Z")).toBe("Mon 5 Oct");
    expect(sentDay("2026-10-04T18:29:00Z")).toBe("Sun 4 Oct");
    expect(requestLine("Brand X", "2026-10-04T20:00:00Z")).toBe(
      "Brand X · sent Mon 5 Oct",
    );
  });

  it("names a request's state", () => {
    expect(requestStateText("open", null)).toBe("Waiting for the admin");
    expect(requestStateText("connected", null)).toBe("Connected");
    expect(requestStateText("dismissed", "Use the Sapiens tracker")).toBe(
      "Not taken: Use the Sapiens tracker",
    );
  });
});

describe("New tracker requested in Needs Attention (N86, 12.8)", () => {
  const detail = {
    requestId: 4,
    userId: "u",
    fileId: "f",
    fileName: "Brand X",
    taskCount: 10,
    unknownNames: 0,
    templateId: "knit-standard-v2",
    note: null,
  };

  it("is titled and described as 12.8 says", () => {
    expect(ATTENTION_TITLES.tracker_request).toBe("New tracker requested");
    expect(describeAttention("tracker_request", detail, "Shlok")).toBe(
      'Shlok asks to connect "Brand X": 10 tasks, in the Knit Standard Tracker v2 layout.',
    );
    expect(
      describeAttention(
        "tracker_request",
        {
          ...detail,
          taskCount: 1,
          unknownNames: 1,
          templateId: "knit-standard-v1",
          note: "For Brand X ads",
        },
        "Shlok",
      ),
    ).toBe(
      'Shlok asks to connect "Brand X": 1 task, in the Knit Standard Tracker v1 layout. 1 name in it is not known to Knit yet. Note: "For Brand X ads"',
    );
    expect(
      describeAttention(
        "tracker_request",
        { ...detail, unknownNames: 3 },
        "Shlok",
      ),
    ).toContain("3 names in it are not known to Knit yet.");
  });

  it("is grouped under Knit, with the items that have no tracker", () => {
    const groups = groupAttention([
      { kind: "tracker_request", tracker: null },
      { kind: "calendar_ending", tracker: null },
      { kind: "unknown_owner", tracker: { id: "t", name: "Brand Y" } },
    ]);
    expect(groups[0]!.tracker).toBeNull();
    expect(groups[0]!.kinds.map((k) => k.title)).toEqual([
      "New tracker requested",
      "Calendar ending",
    ]);
  });
});
