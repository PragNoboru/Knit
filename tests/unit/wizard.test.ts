import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { isEmptyRow, normaliseRow } from "@/lib/domain/rows";
import {
  columnSamples,
  completedOnPatternProblem,
  dateParseRate,
  draftProblems,
  finalConfig,
  goLiveDefault,
  nextColour,
  previewStats,
  statusChoices,
  suggestHeaderRow,
  unknownOwnerNames,
  unmappedChoices,
  writeBackOptions,
  writeBackValue,
  writeBackWords,
  writeTargetProblem,
  type DraftConfig,
} from "@/lib/domain/wizard";
import { MemorySheetSource } from "@/lib/sheets/memory";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD 11 (M8): the setup wizard's rules, over the example trackers.

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;

interface Entry {
  fixture: string;
  tab: string;
  name: string;
  [key: string]: unknown;
}
const registry = read<{
  referenceToday: string;
  people: { alias: string; user: string | null }[];
  trackers: Entry[];
}>("trackers.config.json");
const TODAY = registry.referenceToday;
const holidays = read<{ holidays: { date: string; name: string }[] }>(
  "holidays.json",
).holidays;
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31"),
);
const aliases = aliasMap(
  registry.people.map((p) => ({
    aliasNorm: normaliseKey(p.alias),
    userId: p.user,
  })),
);
const source = new MemorySheetSource(
  loadXlsxFolder(
    fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
  ),
);

async function open(entry: Entry) {
  const config = TrackerConfig.parse(entry);
  const fileId = entry.fixture
    .split("/")
    .pop()!
    .replace(/\.xlsx$/, "");
  const tab = (await source.listTabs(fileId)).find(
    (t) => t.title === entry.tab,
  )!;
  const ref = { fileId, sheetId: tab.sheetId };
  return { config, ref };
}

const byName = (name: string) =>
  registry.trackers.find((t) => t.name === name)!;

describe("header row (11 step 3)", () => {
  it("suggests the first mostly-text row", () => {
    expect(
      suggestHeaderRow(
        [
          ["Filing Buddy launch"],
          [],
          ["Mon 28 Sep", "Tue 29 Sep", "Wed 30 Sep"],
          ["ID", "Date", "Task", "Status"],
          ["G01", "Mon 28 Sep", "Remove the menu item", "Not started"],
        ],
        TODAY,
      ),
    ).toBe(4);
    expect(suggestHeaderRow([], TODAY)).toBe(1);
  });

  it.each(registry.trackers.map((t) => [t.name, t] as const))(
    "finds the header row of %s",
    async (_name, entry) => {
      const { config, ref } = await open(entry);
      expect(suggestHeaderRow(await source.readTopRows(ref, 10), TODAY)).toBe(
        config.headerRow,
      );
    },
  );
});

describe("columns and statuses (11 steps 4 and 5)", () => {
  it("reads nearly every date and names the ones it cannot", async () => {
    const { config, ref } = await open(byName("Filing Buddy · Google Ads"));
    const rows = await source.readRows(ref, config.headerRow);
    const rate = dateParseRate(rows, config.columns.date, TODAY);
    expect(rate.total).toBe(34);
    expect(rate.rate).toBe(1);
    expect(columnSamples(rows, config.columns.date)).toHaveLength(5);

    await source.setCell(ref, config.headerRow, 2, config.columns.date, "TBD");
    const after = dateParseRate(
      await source.readRows(ref, config.headerRow),
      config.columns.date,
      TODAY,
    );
    expect(after.failing).toEqual(["TBD"]);
    expect(after.rate).toBeCloseTo(33 / 34);
  });

  it("lists the dropdown's words and the words found, with their counts", async () => {
    const { config, ref } = await open(byName("Filing Buddy · Meta Ads"));
    const structure = await source.readStructure(ref, config.headerRow);
    const dropdown =
      structure.validations[normaliseKey(config.columns.statusRead)]?.options ??
      null;
    const rows = (await source.readRows(ref, config.headerRow)).filter(
      (row) => !isEmptyRow(row, config),
    );
    const choices = statusChoices(rows, config.columns.statusRead, dropdown);
    expect(choices.map((c) => c.key)).toEqual(
      expect.arrayContaining(["not started", "done"]),
    );
    expect(choices.find((c) => c.key === "not started")!.count).toBeGreaterThan(
      0,
    );
    expect(unmappedChoices(choices, config.statusMap)).toEqual([]);
    expect(unmappedChoices(choices, {}).length).toBe(choices.length);
    expect(writeBackWords(choices)).toContain("Not started");
  });
});

describe("draft and activation (11)", () => {
  it("names what is missing, step by step", () => {
    expect(draftProblems({}).map((p) => p.step)).toEqual([
      "header",
      "columns",
      "columns",
      "columns",
      "statuses",
      "statuses",
    ]);
  });

  it("turns a finished draft into the tracker's registry", () => {
    const expected = TrackerConfig.parse(byName("Noboru · CA Campaign"));
    const draft: DraftConfig = {
      headerRow: expected.headerRow,
      columns: expected.columns,
      readOnlyColumns: expected.readOnlyColumns,
      titleTemplate: expected.titleTemplate,
      subtitleTemplate: expected.subtitleTemplate,
      detailColumns: expected.detailColumns,
      ownerSeparators: expected.ownerSeparators,
      ownerFilter: expected.ownerFilter,
      offDayPolicy: expected.offDayPolicy,
      statusMap: expected.statusMap,
      cancelReasons: expected.cancelReasons,
      writeBack: expected.writeBack,
      completedOnFormat: expected.completedOnFormat,
    };
    expect(draftProblems(draft)).toEqual([]);
    const result = finalConfig(draft);
    expect(result.success && result.data).toEqual(expected);
  });

  it("previews the counts before anything is written (11 step 8)", async () => {
    const entry = byName("Filing Buddy · Meta Ads");
    const { config, ref } = await open(entry);
    const rows = (await source.readRows(ref, config.headerRow))
      .filter((row) => !isEmptyRow(row, config))
      .map((row) =>
        normaliseRow(row, {
          config,
          calendar,
          aliases,
          trackerOwnerId: null,
          today: TODAY,
          knitIdHeader: "Knit ID",
        }),
      );
    const stats = previewStats(rows, "2026-09-28");
    expect(stats).toMatchObject({
      tasks: 23,
      mine: 20,
      byKind: { single: 21, window: 1, open: 1 },
      unmappedStatuses: [],
    });
    expect(unknownOwnerNames(rows)).toEqual([]);
  });

  it("gives a new tracker the first unused colour", () => {
    expect(nextColour([])).toBe("indigo");
    expect(nextColour(["indigo", "teal"])).toBe("amber");
  });
});

// Audit findings 10, 34, 35, 36, 61: the rules the setup wizard's actions check.
describe("the wizard's checks", () => {
  it("fixture configs pass every check", async () => {
    for (const entry of registry.trackers) {
      const config = TrackerConfig.parse(entry);
      expect(writeTargetProblem(config.columns, config.titleTemplate)).toBe(
        null,
      );
      if (config.completedOnFormat?.type === "text")
        expect(
          completedOnPatternProblem(config.completedOnFormat.pattern, TODAY),
        ).toBe(null);
    }
  });

  it("blocks activation while a word of the status column is unmapped (11 step 5)", () => {
    const expected = TrackerConfig.parse(byName("Noboru · CA Campaign"));
    const draft: DraftConfig = { ...expected };
    expect(draftProblems(draft, { unmappedWords: [] })).toEqual([]);
    expect(draftProblems(draft, { unmappedWords: ["Posted", ""] })).toEqual([
      {
        step: "statuses",
        problem:
          "Choose a Knit status for every word. Not mapped yet: Posted, (blank).",
      },
    ]);
  });

  it("offers write-back words from the status write column (6.8)", async () => {
    const { config, ref } = await open(byName("Filing Buddy · Meta Ads"));
    const rows = await source.readRows(ref, config.headerRow);
    const structure = await source.readStructure(ref, config.headerRow);
    const dropdown = (header: string) =>
      structure.validations[normaliseKey(header)]?.options ?? null;
    // Read from Status, write to the Phase column: the words are Phase's, not Status's.
    const words = writeBackOptions(rows, "Phase", dropdown("Phase"));
    const phases = writeBackWords(statusChoices(rows, "Phase", null));
    expect(words).toEqual(phases);
    expect(words).not.toContain("Not started");
    expect(writeBackOptions(rows, "Status", dropdown("Status"))).toContain(
      "Not started",
    );
    expect(writeBackOptions(rows, null, null)).toEqual([]);
  });

  it("accepts only an offered write-back word, leave unchanged or clear", () => {
    expect(writeBackValue("Yes", ["Yes", "No"], true)).toEqual({
      ok: true,
      value: "Yes",
    });
    expect(writeBackValue("Posted", ["Yes", "No"], true)).toEqual({
      ok: false,
    });
    expect(writeBackValue("__leave__", [], false)).toEqual({
      ok: true,
      value: null,
    });
    expect(writeBackValue("__clear__", ["Yes"], true)).toEqual({
      ok: true,
      value: "",
    });
    expect(writeBackValue("__clear__", [], false)).toEqual({ ok: false });
    expect(writeBackValue("Yes", ["Yes"], false)).toEqual({ ok: false });
  });

  it("never lets a write target be a content column (invariant 5)", () => {
    const columns = TrackerConfig.parse(
      byName("Filing Buddy · Google Ads"),
    ).columns;
    const problem = (change: Partial<typeof columns>, title = "{Task}") =>
      writeTargetProblem({ ...columns, ...change }, title);
    expect(problem({})).toBe(null);
    expect(problem({ completedOn: "Date" })).toMatch(/planned date/);
    expect(problem({ statusWrite: "Task" })).toMatch(/the title/);
    expect(problem({ statusWrite: "Phase" }, "{ID} · {Phase}")).toMatch(
      /part of the title/,
    );
    expect(problem({ completedOn: "Owner" })).toMatch(/the owner/);
    expect(problem({ statusWrite: "ID" })).toMatch(/source ID/);
    expect(problem({ completedOn: "Blocks go-live?" })).toMatch(
      /critical flag/,
    );
    expect(problem({ completedOn: "Knit Note" })).toMatch(/Knit's own/);
    expect(problem({ statusWrite: "Done on" })).toBe(
      "Status (write) and Completed on must be different columns.",
    );
    expect(problem({ statusWrite: null, completedOn: "status" })).toBe(
      "Completed on cannot be the column Knit reads the status from.",
    );
    // Status (write) may be the column Knit reads the status from (all four trackers do).
    expect(problem({ statusWrite: "Status" })).toBe(null);
    expect(
      draftProblems({ columns: { ...columns, completedOn: "Date" } }).some(
        (p) => p.step === "columns" && /planned date/.test(p.problem),
      ),
    ).toBe(true);
  });

  it("accepts only completed-on patterns that read back as the same date (6.8)", () => {
    for (const pattern of [
      "EEE d MMM",
      "d MMM",
      "dd/MM/yyyy",
      "d MMM yyyy",
      "yyyy-MM-dd",
      "dd-MM-yyyy",
    ])
      expect(completedOnPatternProblem(pattern, TODAY)).toBe(null);
    for (const pattern of [
      "dd/mm/yyyy", // "28/mm/2026"
      "DD/MM/YYYY", // "DD/09/2026"
      "EEEE", // no day or month
      "MMM yyyy", // no day
      "d", // no month
      "Done 'on' d MMM",
    ])
      expect(completedOnPatternProblem(pattern, TODAY)).toMatch(
        /cannot write dates as/,
      );
  });

  it("defaults go-live to today until the admin saves a date at step 7 (11 step 7)", () => {
    const tracker = {
      state: "draft",
      goLiveDate: "2026-09-28",
      draft: {} as DraftConfig,
    };
    expect(goLiveDefault(tracker, "2026-09-30")).toBe("2026-09-30");
    expect(
      goLiveDefault(
        { ...tracker, draft: { goLiveChosen: true } },
        "2026-09-30",
      ),
    ).toBe("2026-09-28");
    expect(goLiveDefault({ ...tracker, state: "active" }, "2026-09-30")).toBe(
      "2026-09-28",
    );
  });
});
