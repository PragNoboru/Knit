import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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

      // Every mapped header exists.
      const headers = new Set(structure.headers.map((h) => h.normalised));
      for (const header of [
        config.columns.date,
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

    it("never offers a formula column as a write target (N6)", async () => {
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
