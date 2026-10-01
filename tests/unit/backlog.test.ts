import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bringToTodayDay, bringToTodayHint } from "@/lib/domain/backlog";
import {
  CalendarNotCoveredError,
  calendarDaysFromRules,
  calendarFromDays,
  type Holiday,
} from "@/lib/domain/calendar";
import { renderKnitNote } from "@/lib/domain/note";

// PRD 6.11, N61: Bring to today puts the task-day on the first working day on or after the
// later of today and go-live, so never before go-live and never on an off day.

const { holidays } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../fixtures/holidays.json", import.meta.url)),
    "utf8",
  ),
) as { holidays: Holiday[] };

// October 2026 to the end of the year; Sat 31 Oct (5th Saturday, N2) and Fri 2 Oct (Gandhi
// Jayanti) are off.
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-09-01", "2026-12-31"),
);

const ACTIVATED = "2026-09-30"; // Wed
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)
const HOLIDAY = "2026-10-02"; // Fri, Gandhi Jayanti
const SAT = "2026-10-03"; // Sat, 1st Saturday: a working day
const SUN = "2026-10-04"; // Sun
const MON = "2026-10-05"; // Mon

describe("bringToTodayDay (N61)", () => {
  it("is the go-live date while go-live is still ahead and a working day", () => {
    expect(bringToTodayDay(GO_LIVE, ACTIVATED, calendar)).toBe(GO_LIVE);
  });

  it("is the working day after go-live when go-live is an off day", () => {
    expect(bringToTodayDay(HOLIDAY, ACTIVATED, calendar)).toBe(SAT);
    expect(bringToTodayDay(SUN, ACTIVATED, calendar)).toBe(MON);
  });

  it("is today on and after the go-live date when today is a working day", () => {
    expect(bringToTodayDay(GO_LIVE, GO_LIVE, calendar)).toBe(GO_LIVE);
    expect(bringToTodayDay(GO_LIVE, SAT, calendar)).toBe(SAT);
  });

  it("is the next working day when today, after go-live, is an off day", () => {
    expect(bringToTodayDay(GO_LIVE, HOLIDAY, calendar)).toBe(SAT);
    expect(bringToTodayDay(GO_LIVE, SUN, calendar)).toBe(MON);
  });

  it("refuses a day the calendar does not reach (invariant 7)", () => {
    expect(() => bringToTodayDay("2027-01-04", ACTIVATED, calendar)).toThrow(
      CalendarNotCoveredError,
    );
    // The last day is covered but off, and the calendar ends before the next working day.
    const short = calendarFromDays(
      calendarDaysFromRules(holidays, "2026-09-01", SUN),
    );
    expect(() => bringToTodayDay(SUN, ACTIVATED, short)).toThrow(
      CalendarNotCoveredError,
    );
  });
});

describe("the backlog review's hint (N61)", () => {
  it("says where Bring to today puts tasks while go-live is ahead", () => {
    expect(bringToTodayHint(GO_LIVE, ACTIVATED, calendar)).toBe(
      "Go-live is Thu 1 Oct, so Bring to today puts tasks on Thu 1 Oct, not today.",
    );
  });

  it("names the next working day when go-live is an off day", () => {
    expect(bringToTodayHint(HOLIDAY, ACTIVATED, calendar)).toBe(
      "Go-live is Fri 2 Oct, a day off (Gandhi Jayanti), so Bring to today puts tasks on Sat 3 Oct, the next working day.",
    );
  });

  it("names the next working day when today is an off day after go-live", () => {
    expect(bringToTodayHint(GO_LIVE, SUN, calendar)).toBe(
      "Today is a day off (Sunday), so Bring to today puts tasks on Mon 5 Oct, the next working day.",
    );
  });

  it("says nothing when Bring to today puts tasks on today", () => {
    expect(bringToTodayHint(GO_LIVE, GO_LIVE, calendar)).toBeNull();
    expect(bringToTodayHint(GO_LIVE, SAT, calendar)).toBeNull();
  });

  it("says Bring to today is refused when the calendar does not reach the day", () => {
    expect(bringToTodayHint("2027-01-04", ACTIVATED, calendar)).toBe(
      "The calendar does not cover Mon 4 Jan yet, so Bring to today cannot place tasks.",
    );
  });
});

describe("the Knit Note of a task brought to the go-live day (6.9, N61)", () => {
  // Brought on activation day: one task-day on go-live, spill index 1, origin backlog, open.
  const task = {
    status: "in_progress" as const,
    statusReason: null,
    completedOn: null,
    dueDate: "2026-09-29",
    historyOnly: false,
  };
  const days = [
    {
      day: GO_LIVE,
      spillIndex: 1,
      locked: false,
      status: "in_progress" as const,
    },
  ];

  it("reads as spilled once, due on go-live, before and on go-live", () => {
    expect(renderKnitNote(task, days, ACTIVATED)).toBe(
      "Spilled 1x · now due Thu 1 Oct · In progress",
    );
    expect(renderKnitNote(task, days, GO_LIVE)).toBe(
      "Spilled 1x · now due Thu 1 Oct · In progress",
    );
  });
});
