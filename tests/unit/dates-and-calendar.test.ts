import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  calendarDaysFromRules,
  calendarFromDays,
  CalendarNotCoveredError,
} from "@/lib/domain/calendar";
import { parsePlannedDate, type CellValue } from "@/lib/domain/dates";
import { dueDateFor } from "@/lib/domain/due-date";
import {
  addDays,
  formatDate,
  formatDay,
  fromSheetsSerial,
  isoWeekday,
  minutesIST,
  todayIST,
  toSheetsSerial,
} from "@/lib/time";

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as T;

interface DateCase {
  cell: "date" | "text" | "empty";
  input: string;
  expect: { kind: string; start?: string; end?: string; reason?: string };
}

const { referenceToday, cases } = fixture<{
  referenceToday: string;
  cases: DateCase[];
}>("date-parser.cases.json");
const { holidays } = fixture<{ holidays: { date: string; name: string }[] }>(
  "holidays.json",
);
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31"),
);

function cellFor(c: DateCase): CellValue {
  if (c.cell === "empty") return { value: null, formatted: "" };
  if (c.cell === "date")
    return { value: toSheetsSerial(c.input), formatted: c.input };
  return { value: c.input, formatted: c.input };
}

describe("lib/time (invariant 1)", () => {
  it("does date arithmetic without the machine's timezone", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(isoWeekday("2026-09-28")).toBe(1);
    expect(isoWeekday("2026-10-04")).toBe(7);
    expect(fromSheetsSerial(toSheetsSerial("2026-10-02"))).toBe("2026-10-02");
    expect(fromSheetsSerial(46294.75)).toBe(fromSheetsSerial(46294));
  });

  it("formats like date-fns patterns", () => {
    expect(formatDay("2026-10-05")).toBe("Mon 5 Oct");
    expect(formatDate("2026-10-05", "EEEE d MMMM yyyy")).toBe(
      "Monday 5 October 2026",
    );
    expect(formatDate("2026-10-05", "dd/MM/yy")).toBe("05/10/26");
  });

  it("knows India's date and time for an instant", () => {
    // 18:40 UTC is 00:10 the next day in India.
    expect(todayIST(new Date("2026-09-30T18:40:00Z"))).toBe("2026-10-01");
    expect(todayIST(new Date("2026-09-30T18:20:00Z"))).toBe("2026-09-30");
    expect(minutesIST(new Date("2026-09-30T12:00:00Z"))).toBe(17 * 60 + 30);
  });
});

describe("parsePlannedDate (PRD 6.3.2): every case in date-parser.cases.json", () => {
  it.each(cases.map((c) => [c.cell, c.input, c] as const))(
    "%s %j",
    (_cell, _input, c) => {
      const parsed = parsePlannedDate(cellFor(c), referenceToday);
      expect(parsed).toEqual(c.expect);
    },
  );

  it.each([
    ["Monday, 28 September", "2026-09-28"],
    ["28th Sep 2026", "2026-09-28"],
    ["Sept 28", "2026-09-28"],
    [`28 Sep${String.fromCharCode(0xa0)}`, "2026-09-28"],
  ])("also reads %j", (text, start) => {
    expect(
      parsePlannedDate({ value: text, formatted: text }, referenceToday),
    ).toEqual({
      kind: "single",
      start,
    });
  });

  it("reads an en dash in a window like a hyphen", () => {
    const text = `1${String.fromCharCode(0x2013)}6 Oct`;
    expect(
      parsePlannedDate({ value: text, formatted: text }, referenceToday),
    ).toEqual({
      kind: "window",
      start: "2026-10-01",
      end: "2026-10-06",
    });
  });
});

describe("working-day calendar (PRD 6.2)", () => {
  // Every day of October 2026, by hand (PRD 17).
  const october: Record<string, string | null> = {};
  for (let d = 1; d <= 31; d += 1)
    october[`2026-10-${String(d).padStart(2, "0")}`] = null;
  Object.assign(october, {
    "2026-10-02": "Gandhi Jayanti",
    "2026-10-04": "Sunday",
    "2026-10-10": "2nd Saturday",
    "2026-10-11": "Sunday",
    "2026-10-18": "Sunday",
    "2026-10-20": "Dussehra",
    "2026-10-24": "4th Saturday",
    "2026-10-25": "Sunday",
    "2026-10-31": "5th Saturday",
  });

  it.each(Object.entries(october))("%s off reason: %s", (day, reason) => {
    expect(calendar.offReason(day)).toBe(reason);
    expect(calendar.isWorkingDay(day)).toBe(reason === null);
  });

  it("works the 1st and 3rd Saturdays only", () => {
    expect(calendar.isWorkingDay("2026-10-03")).toBe(true);
    expect(calendar.isWorkingDay("2026-10-17")).toBe(true);
    expect(calendar.offReason("2027-01-30")).toBe("5th Saturday");
  });

  it("steps over off days", () => {
    expect(calendar.nextWorkingDay("2026-10-01")).toBe("2026-10-03");
    expect(calendar.nextWorkingDay("2026-10-03")).toBe("2026-10-05");
    expect(calendar.prevWorkingDay("2026-10-25")).toBe("2026-10-23");
    expect(calendar.prevWorkingDay("2026-11-08")).toBe("2026-11-07");
  });

  it("refuses days it does not cover", () => {
    expect(() => calendar.isWorkingDay("2028-01-03")).toThrow(
      CalendarNotCoveredError,
    );
    expect(() => calendar.nextWorkingDay("2027-12-31")).toThrow(
      CalendarNotCoveredError,
    );
  });
});

describe("due date policy (PRD 6.3.3, N1)", () => {
  interface OffDayExample {
    planned: string;
    due: string;
  }
  const trackers = fixture<{
    trackers: {
      name: string;
      expected: { offDayExamples?: OffDayExample[] };
    }[];
  }>("trackers.config.json").trackers;
  const examples = trackers.flatMap((t) =>
    (t.expected.offDayExamples ?? []).map(
      (e) => [t.name, e.planned, e.due] as const,
    ),
  );

  it.each(examples)("%s: planned %s is due %s", (_tracker, planned, due) => {
    expect(
      dueDateFor(
        { kind: "single", start: planned },
        "previous_working_day",
        calendar,
      ),
    ).toBe(due);
  });

  it("applies the other policies and windows", () => {
    const sunday = { kind: "single", start: "2026-10-25" } as const;
    expect(dueDateFor(sunday, "next_working_day", calendar)).toBe("2026-10-26");
    expect(dueDateFor(sunday, "keep", calendar)).toBe("2026-10-25");
    expect(
      dueDateFor(
        { kind: "window", start: "2026-10-01", end: "2026-10-06" },
        "previous_working_day",
        calendar,
      ),
    ).toBe("2026-10-06");
    expect(
      dueDateFor(
        { kind: "open", start: "2026-10-30" },
        "previous_working_day",
        calendar,
      ),
    ).toBeNull();
  });
});
