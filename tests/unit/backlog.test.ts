import { describe, expect, it } from "vitest";

import { bringToTodayDay, bringToTodayHint } from "@/lib/domain/backlog";
import { renderKnitNote } from "@/lib/domain/note";

// PRD 6.11, N61: Bring to today never puts a task-day before go-live.

const ACTIVATED = "2026-09-30"; // Wed
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)

describe("bringToTodayDay (N61)", () => {
  it("is the go-live date while go-live is still ahead", () => {
    expect(bringToTodayDay(GO_LIVE, ACTIVATED)).toBe(GO_LIVE);
  });

  it("is today on and after the go-live date", () => {
    expect(bringToTodayDay(GO_LIVE, GO_LIVE)).toBe(GO_LIVE);
    expect(bringToTodayDay(GO_LIVE, "2026-10-03")).toBe("2026-10-03");
  });
});

describe("the backlog review's hint (N61)", () => {
  it("says where Bring to today puts tasks while go-live is ahead", () => {
    expect(bringToTodayHint(GO_LIVE, ACTIVATED)).toBe(
      "Go-live is Thu 1 Oct, so Bring to today puts tasks on Thu 1 Oct, not today.",
    );
  });

  it("says nothing from the go-live date on", () => {
    expect(bringToTodayHint(GO_LIVE, GO_LIVE)).toBeNull();
    expect(bringToTodayHint(GO_LIVE, "2026-10-03")).toBeNull();
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
