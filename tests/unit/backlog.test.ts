import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  backlogReviewHint,
  bringToTodayDay,
  bringToTodayHint,
} from "@/lib/domain/backlog";
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

// 1 Sep 2026 to 31 Dec 2026. In October, Fri 2 Oct (Gandhi Jayanti), Sat 10 Oct (2nd Saturday),
// Sat 24 Oct (4th Saturday) and Sat 31 Oct (5th Saturday, N2) are off; Sat 3 Oct and Sat 17 Oct
// (1st and 3rd) are working days.
const calendar = calendarFromDays(
  calendarDaysFromRules(holidays, "2026-09-01", "2026-12-31"),
);

const ACTIVATED = "2026-09-30"; // Wed
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)
const HOLIDAY = "2026-10-02"; // Fri, Gandhi Jayanti
const SAT = "2026-10-03"; // Sat, 1st Saturday: a working day
const SUN = "2026-10-04"; // Sun
const MON = "2026-10-05"; // Mon
const SAT_2ND = "2026-10-10"; // Sat, 2nd Saturday: off
const MON_12 = "2026-10-12"; // Mon
const SAT_4TH = "2026-10-24"; // Sat, 4th Saturday: off
const MON_26 = "2026-10-26"; // Mon

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

  it("skips a 2nd or 4th Saturday and the Sunday after it (6.2)", () => {
    expect(bringToTodayDay(GO_LIVE, SAT_2ND, calendar)).toBe(MON_12);
    expect(bringToTodayDay(SAT_4TH, ACTIVATED, calendar)).toBe(MON_26);
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

  it("names a 4th Saturday go-live as a day off", () => {
    expect(bringToTodayHint(SAT_4TH, ACTIVATED, calendar)).toBe(
      "Go-live is Sat 24 Oct, a day off (4th Saturday), so Bring to today puts tasks on Mon 26 Oct, the next working day.",
    );
  });

  it("names the next working day when today is a 2nd Saturday after go-live", () => {
    expect(bringToTodayHint(GO_LIVE, SAT_2ND, calendar)).toBe(
      "Today is a day off (2nd Saturday), so Bring to today puts tasks on Mon 12 Oct, the next working day.",
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
      "The calendar does not cover Mon 4 Jan 2027 yet, so Bring to today cannot place tasks.",
    );
  });

  it("from the loaded calendar rows: the same hint, and with no rows the page still renders", () => {
    const days = calendarDaysFromRules(holidays, "2026-09-01", "2026-12-31");
    expect(backlogReviewHint(GO_LIVE, SUN, days)).toBe(
      bringToTodayHint(GO_LIVE, SUN, calendar),
    );
    expect(backlogReviewHint(GO_LIVE, GO_LIVE, days)).toBeNull();
    // An empty calendar reaches no day: Bring to today is refused, the hint says so.
    expect(backlogReviewHint(GO_LIVE, ACTIVATED, [])).toBe(
      "The calendar does not cover Thu 1 Oct 2026 yet, so Bring to today cannot place tasks.",
    );
    expect(backlogReviewHint(GO_LIVE, SAT, [])).toBe(
      "The calendar does not cover Sat 3 Oct 2026 yet, so Bring to today cannot place tasks.",
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
