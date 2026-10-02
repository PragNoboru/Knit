import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { isEmptyRow, normaliseRow } from "@/lib/domain/rows";
import { XlsxFixtureSource } from "@/lib/sheets/xlsx";

// PRD 17 "Fixture tests": the whole read path (XlsxFixtureSource + config + domain) over each
// example tracker must reproduce the `expected` block in fixtures/trackers.config.json.

const read = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;

interface Expected {
  rows: number;
  myRows: number;
  notMine?: Record<string, number>;
  kinds?: Record<string, number>;
  offDayRows?: number;
  offDayExamples?: { planned: string; due: string }[];
  formulaColumns?: string[];
  unmappedStatuses: string[];
}

interface FixtureEntry {
  fixture: string;
  tab: string;
  name: string;
  expected: Expected;
  [key: string]: unknown;
}

const registry = read<{
  referenceToday: string;
  people: { alias: string; user: string | null }[];
  trackers: FixtureEntry[];
}>("trackers.config.json");
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
const source = new XlsxFixtureSource(
  fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
);
const ME = "pragaman@noboruworld.com";

async function readTracker(entry: FixtureEntry) {
  const config = TrackerConfig.parse(entry);
  const fileId = entry.fixture
    .split("/")
    .pop()!
    .replace(/\.xlsx$/, "");
  const tab = (await source.listTabs(fileId)).find(
    (t) => t.title === entry.tab,
  )!;
  const ref = { fileId, sheetId: tab.sheetId };
  const structure = await source.readStructure(ref, config.headerRow);
  const rows = (await source.readRows(ref, config.headerRow))
    .filter((row) => !isEmptyRow(row, config))
    .map((row) =>
      normaliseRow(row, {
        config,
        calendar,
        aliases,
        trackerOwnerId: null,
        today: registry.referenceToday,
        knitIdHeader: "Knit ID",
      }),
    );
  return { config, structure, rows };
}

describe.each(registry.trackers.map((t) => [t.name, t] as const))(
  "%s",
  (_name, entry) => {
    it("reproduces every number in its expected block", async () => {
      const { config, structure, rows } = await readTracker(entry);
      const e = entry.expected;

      // Every mapped header exists, the End date included (N64).
      const headers = new Set(structure.headers.map((h) => h.normalised));
      for (const header of [
        config.columns.date,
        ...(config.columns.endDate ? [config.columns.endDate] : []),
        config.columns.title,
        config.columns.statusRead,
      ]) {
        expect(headers.has(normaliseKey(header)), header).toBe(true);
      }

      expect(rows).toHaveLength(e.rows);
      expect(rows.filter((r) => r.assignees.includes(ME))).toHaveLength(
        e.myRows,
      );

      if (e.notMine) {
        const notMine: Record<string, number> = {};
        for (const r of rows.filter((r) => !r.assignees.includes(ME))) {
          notMine[r.ownerRaw ?? ""] = (notMine[r.ownerRaw ?? ""] ?? 0) + 1;
        }
        expect(notMine).toEqual(e.notMine);
      }
      if (e.kinds) {
        const kinds: Record<string, number> = {};
        for (const r of rows)
          kinds[r.date.kind] = (kinds[r.date.kind] ?? 0) + 1;
        expect(kinds).toEqual(e.kinds);
      }
      if (e.offDayRows !== undefined) {
        expect(rows.filter((r) => r.offDayMove)).toHaveLength(e.offDayRows);
      }
      for (const example of e.offDayExamples ?? []) {
        const row = rows.find(
          (r) => r.date.kind === "single" && r.date.start === example.planned,
        );
        expect(row?.dueDate, `planned ${example.planned}`).toBe(example.due);
      }
      if (e.formulaColumns) {
        expect([...structure.formulaColumns].sort()).toEqual(
          e.formulaColumns.map(normaliseKey).sort(),
        );
      }
      const unmapped = [
        ...new Set(
          rows.filter((r) => !r.status.mapped).map((r) => r.statusRaw),
        ),
      ];
      expect(unmapped).toEqual(e.unmappedStatuses);
      expect(
        rows.every((r) => r.date.kind !== "invalid" && r.date.kind !== "empty"),
      ).toBe(true);
    });

    // A check on the fixture registry, not on Knit's guards: those are tested in
    // tests/unit/structure.test.ts and tests/integration/structure.test.ts.
    it("fixture registry maps no detected formula column as a write target (N6)", async () => {
      const { config, structure } = await readTracker(entry);
      const writeTargets = [
        config.columns.statusWrite,
        config.columns.completedOn,
      ].filter((h): h is string => h !== null);
      for (const target of writeTargets) {
        expect(structure.formulaColumns).not.toContain(normaliseKey(target));
      }
    });
  },
);

describe("dropdown rules (PRD 6.8, 11 step 5)", () => {
  it("reads Filing Buddy's Status options, all of them mapped", async () => {
    const entry = registry.trackers.find(
      (t) => t.name === "Filing Buddy · Google Ads",
    )!;
    const { config, structure } = await readTracker(entry);
    const options = structure.validations.status?.options ?? [];
    expect(options).toEqual([
      "Not started",
      "In progress",
      "Done",
      "Blocked",
      "Skipped",
    ]);
    for (const option of options)
      expect(config.statusMap[normaliseKey(option)], option).toBeDefined();
  });

  it("reads the Knit Standard Tracker v1 Status options from Lists!A2:A6, all of them mapped (11.1)", async () => {
    const entry = registry.trackers.find(
      (t) => t.name === "Knit Standard · Example",
    )!;
    const { config, structure } = await readTracker(entry);
    expect(structure.validations.status).toEqual({
      options: ["Not started", "In progress", "Blocked", "Done", "Cancelled"],
      source: "Lists!$A$2:$A$6",
    });
    for (const option of structure.validations.status!.options!)
      expect(config.statusMap[normaliseKey(option)], option).toBeDefined();
  });

  it("reads the Knit Standard Tracker v2 Status options from Lists!A2:A6 in column J (N74)", async () => {
    const entry = registry.trackers.find(
      (t) => t.name === "Knit Standard v2 · Example",
    )!;
    const { structure } = await readTracker(entry);
    expect(structure.validations.status).toEqual({
      options: ["Not started", "In progress", "Blocked", "Done", "Cancelled"],
      source: "Lists!$A$2:$A$6",
    });
    expect(
      structure.headers.find((h) => h.normalised === "status")?.letter,
    ).toBe("J");
    expect(
      structure.headers.find((h) => h.normalised === "maker")?.letter,
    ).toBe("H");
  });

  it("reports a dropdown fed from a missing tab as unreadable, never guessed", async () => {
    const entry = registry.trackers.find(
      (t) => t.name === "Noboru · CA Campaign",
    )!;
    const { structure } = await readTracker(entry);
    expect(structure.validations.done).toEqual({
      options: null,
      source: "Lists!$A$2:$A$5",
    });
  });
});

describe("Owner and Maker in the v2 example (N72, N73)", () => {
  const rowsOf = async () => {
    const entry = registry.trackers.find(
      (t) => t.name === "Knit Standard v2 · Example",
    )!;
    const { rows } = await readTracker(entry);
    return new Map(rows.map((r) => [r.sourceRef, r]));
  };

  it("assigns the Maker, or the Owner when Maker is blank, and keeps the Owner's text", async () => {
    const rows = await rowsOf();
    const pick = (ref: string) => {
      const r = rows.get(ref)!;
      return {
        mine: r.assignees.includes(ME),
        maker: r.ownerRaw,
        owner: r.details.Owner ?? null,
        unknown: r.unknownOwners,
      };
    };
    // Same person.
    expect(pick("NOB-01")).toEqual({
      mine: true,
      maker: "Pragaman",
      owner: "Pragaman",
      unknown: [],
    });
    // Blank Maker: the Owner does it.
    expect(pick("NOB-02")).toEqual({
      mine: true,
      maker: null,
      owner: "Pragaman",
      unknown: [],
    });
    // Different Owner and Maker: the Maker's.
    expect(pick("NOB-03")).toEqual({
      mine: true,
      maker: "Pragaman",
      owner: "Shlok",
      unknown: [],
    });
    // Comma lists.
    expect(pick("NOB-04")).toMatchObject({
      mine: true,
      maker: "Pragaman, Shlok",
    });
    expect(pick("NOB-06")).toMatchObject({ mine: true, owner: "Shlok" });
    // Pragaman only checks it: Creative makes it.
    expect(pick("NOB-08")).toEqual({
      mine: false,
      maker: "Creative",
      owner: "Pragaman",
      unknown: [],
    });
    // An Owner Knit does not know is never looked up while the Maker is filled.
    expect(pick("NOB-10")).toEqual({
      mine: true,
      maker: "P",
      owner: "Riya",
      unknown: [],
    });
  });

  it("has a Guide tab in the v2 words, a model for the blank template (TRACKERS 7)", () => {
    const book = XLSX.read(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../fixtures/trackers/Knit_Standard_Tracker_v2_example.xlsx",
            import.meta.url,
          ),
        ),
      ),
      { type: "buffer" },
    );
    const lines = XLSX.utils
      .sheet_to_json<unknown[]>(book.Sheets.Guide!, { header: 1 })
      .map((row) => row.filter((cell) => cell !== undefined).join(" | "));
    const text = lines.join("\n");
    expect(lines[0]).toBe("Knit Standard Tracker v2");
    expect(text).toContain("Version 2, 2 Oct 2026");
    expect(text).toContain("The 15 standard columns");
    expect(text).not.toMatch(/v1|Version 1|14 standard/);
    expect(text).not.toContain("Who does it, from the Lists tab. Comma");
    // Both tables list Maker right after Owner.
    const owner = lines.findIndex((l) => l.startsWith("Owner | Required"));
    expect(lines[owner]).toContain("Who checks that it is done");
    expect(lines[owner + 1]).toMatch(/^Maker \| Optional \| Who does it/);
    const example = lines.findIndex((l) => l === "Owner | Pragaman");
    expect(lines[example + 1]).toBe("Maker | (blank: the Owner does it)");
  });
});
