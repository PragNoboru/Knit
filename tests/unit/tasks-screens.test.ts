import { describe, expect, it } from "vitest";

import { describeEvent, type TaskEvent } from "@/lib/domain/tasks-screens";

// PRD 12.6: the drawer's history lines are plain language (12.3, 12.7), never raw field names.

const event = (over: Partial<TaskEvent>): TaskEvent => ({
  id: 1,
  at: "2026-10-01T05:00:00Z",
  origin: "source",
  field: "status",
  oldValue: null,
  newValue: null,
  reason: null,
  actor: null,
  ...over,
});

describe("describeEvent (12.6)", () => {
  it("a removal at source reads 'Removed from the sheet' (N11, N30)", () => {
    expect(
      describeEvent(
        event({
          origin: "system",
          field: "removed_at_source",
          newValue: "removed",
          reason: "Removed at source",
        }),
      ),
    ).toEqual({
      what: "Removed from the sheet (Removed at source)",
      where: "by Knit",
      who: "Knit",
    });
  });

  it("a row put back before 1 Oct 2026 reads 'Back in the sheet'", () => {
    expect(
      describeEvent(
        event({
          origin: "system",
          field: "removed_at_source",
          oldValue: "removed",
          newValue: "restored",
        }),
      ).what,
    ).toBe("Back in the sheet");
  });

  it("never shows a raw field name for these events", () => {
    for (const newValue of ["removed", "restored"]) {
      expect(
        describeEvent(event({ field: "removed_at_source", newValue })).what,
      ).not.toContain("removed_at_source");
    }
  });
});
