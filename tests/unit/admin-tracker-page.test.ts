import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";

// PRD 12.8, 14, N39, N43 (review R6): a tracker's page offers the recreate flow only to a
// tracker paused because its Knit ID column is missing. One paused for a doubled Knit ID column
// or for formulas in it is fixed in the sheet and resumed, so its page offers Resume.

const ID = "00000000-0000-4000-8000-0000000000f1";

const fx = vi.hoisted(() => ({
  pauseReason: null as string | null,
  draft: { headerRow: 1 } as AdminTracker["draft"],
  preview: vi.fn(async () => ({ matches: [], newRows: [], missingTasks: [] })),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/admin/data", () => ({
  loadTracker: async (): Promise<AdminTracker> => ({
    id: ID,
    fileId: "sheet-1",
    gid: 7,
    tabName: "Google",
    name: "Filing Buddy · Google Ads",
    color: "amber",
    state: "paused",
    pauseReason: fx.pauseReason,
    draft: fx.draft,
    goLiveDate: "2026-09-28",
    lastPullAt: null,
    ownerUserId: null,
    ref: { fileId: "sheet-1", sheetId: 7 },
  }),
  loadAdminTrackers: async () => ({ trackers: [], files: [] }),
  loadSheetDeps: async () => ({
    store: { trackers: async () => [{ id: ID }] },
    source: {},
  }),
}));
vi.mock("@/lib/sync/recreate-ids", () => ({
  previewKnitIdRecreate: fx.preview,
}));
vi.mock("@/lib/actions/admin", () => ({
  archiveTracker: vi.fn(),
  pauseTracker: vi.fn(),
  recreateKnitIdColumn: vi.fn(),
  resumeTracker: vi.fn(),
  syncTracker: vi.fn(),
}));

async function render(pauseReason: string) {
  fx.pauseReason = pauseReason;
  const { default: TrackerPage } =
    await import("@/app/(app)/admin/trackers/[id]/page");
  return renderToStaticMarkup(
    await TrackerPage({
      params: Promise.resolve({ id: ID }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe("Admin > Tracker", () => {
  beforeEach(() => {
    fx.preview.mockClear();
    fx.draft = { headerRow: 1 };
  });

  it("shows the End date mapping after Date, or None (12.8, N64)", async () => {
    const none = await render("Left the Knit folder");
    expect(none).toContain(
      '<dt class="text-muted-foreground">End date</dt><dd class="break-words">None</dd>',
    );
    fx.draft = {
      headerRow: 1,
      columns: { date: "Date", endDate: "End date" },
    };
    const mapped = await render("Left the Knit folder");
    expect(mapped).toMatch(
      /<dt[^>]*>Date<\/dt><dd[^>]*>Date<\/dd><\/div><div class="contents"><dt[^>]*>End date<\/dt><dd[^>]*>End date<\/dd>/,
    );
  });

  it("offers the recreate flow, not Resume, when the Knit ID column is missing", async () => {
    const html = await render("the Knit ID column is missing");
    expect(html).toContain("Recreate and resume");
    expect(html).not.toMatch(/>Resume</);
    expect(fx.preview).toHaveBeenCalledTimes(1);
  });

  it.each([
    "column 'Knit ID' holds formulas and cannot be written",
    "column 'Knit ID' appears more than once",
  ])(
    "offers Resume, never the recreate flow, when paused with %s",
    async (reason) => {
      const html = await render(reason);
      expect(html).toMatch(/>Resume</);
      expect(html).not.toContain("Recreate");
      expect(fx.preview).not.toHaveBeenCalled();
    },
  );
});
