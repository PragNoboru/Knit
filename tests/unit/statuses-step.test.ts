import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import { STATUSES_LIVE_HINT } from "@/lib/domain/wizard";

// PRD 11 (Editing a live tracker's mapping later), N28, N60: the statuses step of a live
// tracker says that a remapped word reaches only new rows and rows that change to it. Not on a
// draft, and not while the status columns are being changed (N42), where the new column's
// words are changes made in the source.

const text = (v: string) => ({ value: v, formatted: v });

vi.mock("@/lib/admin/data", () => ({
  loadTabData: async () => ({
    structure: {
      headers: [
        { header: "Status", normalised: "status" },
        { header: "Notes", normalised: "notes" },
      ],
      validations: {},
    },
    rows: [
      { rowNumber: 2, cells: { status: text("Done"), notes: text("Done") } },
    ],
  }),
}));
vi.mock("@/lib/actions/admin", () => ({ saveStatuses: vi.fn() }));

function tracker(state: AdminTracker["state"]): AdminTracker {
  return {
    id: "00000000-0000-4000-8000-0000000000f2",
    fileId: "sheet-1",
    gid: 7,
    tabName: "Google",
    name: "Filing Buddy · Google Ads",
    color: "amber",
    state,
    pauseReason: null,
    draft: {
      headerRow: 1,
      columns: { statusRead: "Status", statusWrite: "Status" },
      statusMap: { done: "done" },
    } as AdminTracker["draft"],
    goLiveDate: "2026-09-28",
    lastPullAt: null,
    ownerUserId: null,
    ref: { fileId: "sheet-1", sheetId: 7 },
  };
}

async function render(
  state: AdminTracker["state"],
  pending: { statusRead: string; statusWrite: string } | null = null,
) {
  const { StatusesStep } =
    await import("@/app/(app)/admin/trackers/_parts/steps/statuses");
  return renderToStaticMarkup(
    await StatusesStep({ tracker: tracker(state), pending }),
  );
}

describe("Statuses step: the live-tracker hint (PRD 11, N28)", () => {
  it("is shown, word for word, on an active tracker", async () => {
    expect(await render("active")).toContain(STATUSES_LIVE_HINT);
  });

  it("is not shown on a draft", async () => {
    expect(await render("draft")).not.toContain(STATUSES_LIVE_HINT);
  });

  it("is not shown while the status columns are being changed", async () => {
    const html = await render("active", {
      statusRead: "Notes",
      statusWrite: "Notes",
    });
    expect(html).toContain("The status columns change to");
    expect(html).not.toContain(STATUSES_LIVE_HINT);
  });
});
