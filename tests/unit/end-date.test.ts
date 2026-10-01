import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeAttention } from "@/lib/domain/attention";
import { calendarDaysFromRules, calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import { parsePlannedDate } from "@/lib/domain/dates";
import { planKnitIdRecreate } from "@/lib/domain/knit-id-recreate";
import { aliasMap } from "@/lib/domain/owners";
import type { PlanTask } from "@/lib/domain/planPull";
import {
  cellOf,
  contentHeaders,
  isEmptyRow,
  normaliseRow,
  plannedRawOf,
  textOf,
  type SheetRow,
} from "@/lib/domain/rows";
import { XlsxFixtureSource } from "@/lib/sheets/xlsx";

// PRD 6.3.4, N64 to N66: the End date column's effect on rows, planned_raw, empty-row detection,
// the Knit ID recreate key and the Needs Attention copy (12.8).

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
const calendar = calendarFromDays(
  calendarDaysFromRules(
    read<{ holidays: { date: string; name: string }[] }>("holidays.json")
      .holidays,
    "2026-01-01",
    "2027-12-31",
  ),
);
const aliases = aliasMap(
  registry.people.map((p) => ({
    aliasNorm: normaliseKey(p.alias),
    userId: p.user,
  })),
);
const fbConfig = TrackerConfig.parse(
  registry.trackers.find((t) => t.name === "Filing Buddy · Google Ads"),
);
const withEnd = TrackerConfig.parse({
  ...fbConfig,
  columns: { ...fbConfig.columns, endDate: "End date" },
});

const text = (v: string) => ({ value: v, formatted: v });
function row(
  rowNumber: number,
  cells: { id?: string; date?: string; end?: string; task?: string },
): SheetRow {
  return {
    rowNumber,
    cells: {
      id: text(cells.id ?? ""),
      date: text(cells.date ?? ""),
      "end date": text(cells.end ?? ""),
      task: text(cells.task ?? ""),
      status: text(""),
      owner: text(""),
    },
  };
}

describe("plannedRawOf (N66)", () => {
  it("is the Date text, or 'Date to End date' when an End date is filled", () => {
    expect(plannedRawOf(row(2, { date: "Mon 12 Oct" }), withEnd)).toBe(
      "Mon 12 Oct",
    );
    expect(
      plannedRawOf(row(2, { date: "Mon 12 Oct", end: "Fri 16 Oct" }), withEnd),
    ).toBe("Mon 12 Oct to Fri 16 Oct");
    expect(
      plannedRawOf(row(2, { date: "Mon 12 Oct", end: "Mon 12 Oct" }), withEnd),
    ).toBe("Mon 12 Oct to Mon 12 Oct");
    expect(plannedRawOf(row(2, { end: "Fri 16 Oct" }), withEnd)).toBe(
      "to Fri 16 Oct",
    );
  });

  it("ignores an End date column the tracker does not map", () => {
    expect(
      plannedRawOf(row(2, { date: "Mon 12 Oct", end: "Fri 16 Oct" }), fbConfig),
    ).toBe("Mon 12 Oct");
  });
});

describe("a tracker without an End date reads as before (N64)", () => {
  const source = new XlsxFixtureSource(
    fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
  );
  const withoutEnd = registry.trackers.filter(
    (t) =>
      (t.columns as { endDate?: string | null }).endDate === undefined ||
      (t.columns as { endDate?: string | null }).endDate === null,
  );

  it.each(withoutEnd.map((t) => [t.name, t] as const))(
    "%s: planned_raw is the Date text and the date is parsePlannedDate's",
    async (_name, entry) => {
      const config = TrackerConfig.parse(entry);
      expect(config.columns.endDate).toBe(null);
      const fileId = entry.fixture
        .split("/")
        .pop()!
        .replace(/\.xlsx$/, "");
      const tab = (await source.listTabs(fileId)).find(
        (t) => t.title === entry.tab,
      )!;
      const rows = await source.readRows(
        { fileId, sheetId: tab.sheetId },
        config.headerRow,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const sheetRow of rows) {
        const dateCell = cellOf(sheetRow, config.columns.date);
        const normalised = normaliseRow(sheetRow, {
          config,
          calendar,
          aliases,
          trackerOwnerId: null,
          today: registry.referenceToday,
          knitIdHeader: "Knit ID",
        });
        expect(normalised.plannedRaw).toBe(textOf(dateCell));
        expect(normalised.date).toEqual(
          parsePlannedDate(dateCell, registry.referenceToday),
        );
      }
    },
  );
});

describe("contentHeaders (10.2 step 3, N51)", () => {
  it("includes the End date only when it is mapped", () => {
    expect(contentHeaders(withEnd)).toContain("End date");
    expect(contentHeaders(fbConfig)).not.toContain("End date");
  });

  it("does not treat a row holding only an End date as empty", () => {
    const onlyEnd = row(2, { end: "Fri 16 Oct" });
    expect(isEmptyRow(onlyEnd, withEnd)).toBe(false);
    expect(isEmptyRow(onlyEnd, fbConfig)).toBe(true);
    expect(isEmptyRow(row(3, {}), withEnd)).toBe(true);
  });
});

describe("planKnitIdRecreate with an End date (N19 e, N66)", () => {
  const task = (id: string, title: string, plannedRaw: string) =>
    ({
      id,
      title,
      sourceRef: null,
      plannedRaw,
      removedAtSource: false,
    }) as PlanTask;

  it("matches by title and the 'Date to End date' text the pull stored", () => {
    const plan = planKnitIdRecreate(
      [
        row(2, { task: "Launch week", date: "Mon 12 Oct", end: "Fri 16 Oct" }),
        row(3, { task: "Review", date: "Mon 19 Oct" }),
      ],
      [
        task("t1", "Launch week", "Mon 12 Oct to Fri 16 Oct"),
        task("t2", "Review", "Mon 19 Oct"),
        task("t3", "Launch week", "Mon 12 Oct"),
      ],
      withEnd,
    );
    expect(plan.matches.map((m) => [m.row, m.taskId, m.by])).toEqual([
      [2, "t1", "title_and_date"],
      [3, "t2", "title_and_date"],
    ]);
    expect(plan.missingTasks.map((t) => t.taskId)).toEqual(["t3"]);
  });
});

describe("Needs Attention copy for End date problems (12.8)", () => {
  const sentence = (reason: string, value: string) =>
    describeAttention("bad_date", { row: 4, value, reason });

  it("says why the pair cannot be used", () => {
    expect(sentence("end_without_start", "to Fri 16 Oct")).toBe(
      'The date "to Fri 16 Oct" cannot be used: the End date is filled but the Date is empty.',
    );
    expect(sentence("start_not_single", "1-6 Oct to Fri 9 Oct")).toBe(
      'The date "1-6 Oct to Fri 9 Oct" cannot be used: the Date is already a range or open-ended, so it cannot also have an End date.',
    );
    expect(sentence("end_date_unreadable", "Tue 13 Oct to TBD")).toBe(
      'The date "Tue 13 Oct to TBD" cannot be used: Knit cannot read the End date as one date.',
    );
    expect(sentence("range_end_before_start", "Fri 16 Oct to Mon 12 Oct")).toBe(
      'The date "Fri 16 Oct to Mon 12 Oct" cannot be used: the range ends before it starts.',
    );
  });

  it("uses no em dash", () => {
    for (const reason of [
      "end_without_start",
      "start_not_single",
      "end_date_unreadable",
    ])
      expect(sentence(reason, "x")).not.toContain(String.fromCharCode(0x2014));
  });
});
