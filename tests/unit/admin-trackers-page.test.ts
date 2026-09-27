import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AdminTrackers } from "@/lib/admin/data";

// PRD 12.8 Trackers (audit findings 39, 38, C7): another tab of a connected spreadsheet can be
// set up; a tracker paused for a missing Knit ID column is not offered Resume; a file that is
// not a Google Sheet says how to fix it (7.4).

const data = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/lib/admin/data", () => ({
  loadAdminTrackers: async () => data.value,
  pausedForMissingKnitIds: (reason: string | null) =>
    (reason ?? "").toLowerCase().includes("knit id"),
}));
vi.mock("@/lib/actions/admin", () => ({
  pauseTracker: vi.fn(),
  resumeTracker: vi.fn(),
  setFileIgnored: vi.fn(),
  syncTracker: vi.fn(),
}));

const tracker = (
  over: Partial<AdminTrackers["trackers"][number]>,
): AdminTrackers["trackers"][number] => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Filing Buddy · Google Ads",
  color: "amber",
  state: "active",
  pauseReason: null,
  fileId: "sheet-1",
  gid: 0,
  tabName: "Google",
  fileName: "Filing Buddy",
  lastPullAt: null,
  goLiveDate: "2026-09-28",
  taskCount: 3,
  backlogCount: 0,
  openAttention: 0,
  ...over,
});

async function render(value: AdminTrackers) {
  data.value = value;
  const { default: TrackersPage } =
    await import("@/app/(app)/admin/trackers/page");
  return renderToStaticMarkup(await TrackersPage());
}

describe("Admin > Trackers", () => {
  it("offers to set up another tab of a spreadsheet that has a tracker, once per sheet", async () => {
    const html = await render({
      trackers: [
        tracker({}),
        tracker({
          id: "00000000-0000-4000-8000-000000000002",
          name: "Filing Buddy · Meta Ads",
          tabName: "Meta",
          gid: 7,
        }),
      ],
      files: [],
    });
    expect(html.match(/Set up another tab/g)).toHaveLength(1);
    expect(html).toContain('href="/admin/trackers/new/sheet-1"');
  });

  it("sends a tracker whose Knit ID column is gone to its page, not to Resume", async () => {
    const html = await render({
      trackers: [
        tracker({
          state: "paused",
          pauseReason: "the Knit ID column is missing",
        }),
        tracker({
          id: "00000000-0000-4000-8000-000000000003",
          state: "paused",
          pauseReason: "Left the Knit folder",
          fileId: "sheet-2",
        }),
      ],
      files: [],
    });
    expect(html.match(/Resume/g)).toHaveLength(1);
    expect(html).toContain("Recreate Knit IDs");
  });

  it("says how to turn a file that is not a Google Sheet into one (7.4)", async () => {
    const html = await render({
      trackers: [],
      files: [
        {
          fileId: "x.xlsx",
          name: "Sapiens.xlsx",
          state: "not_a_sheet",
          modifiedTime: null,
          trackers: 0,
        },
      ],
    });
    expect(html).toContain(
      "Sapiens.xlsx: Not a Google Sheet: open it and use File &gt; Save as Google Sheets",
    );
  });
});
