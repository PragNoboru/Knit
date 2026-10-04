import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AttentionItem } from "@/lib/admin/data";

// PRD N86, 12.8: a New tracker requested item offers Set up only while its sheet is listed in
// the Knit folder (the pick-tab page opens only for those), Open the sheet, and a Dismiss that
// asks for a reason; the plain Dismiss of other items is not offered for it.

const data = vi.hoisted(() => ({
  items: [] as unknown[],
  files: [] as unknown[],
}));

vi.mock("@/lib/admin/data", () => ({
  loadAttention: async () => data.items,
  loadPeople: async () => ({ users: [], aliases: [] }),
  loadAdminTrackers: async () => ({ trackers: [], files: data.files }),
}));
vi.mock("@/lib/actions/admin", () => ({
  dismissTrackerRequest: vi.fn(),
  linkOwnerName: vi.fn(),
  mapStatusWord: vi.fn(),
  retryWrites: vi.fn(),
  setAttentionState: vi.fn(),
}));

const FILE = "Knit_Standard_Tracker_v2_example";

const request = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: 31,
  kind: "tracker_request",
  detail: {
    requestId: 5,
    userId: "u",
    fileId: FILE,
    fileName: "Brand Zeta",
    taskCount: 10,
    unknownNames: 2,
    templateId: "knit-standard-v2",
    note: "For the Zeta launch",
  },
  createdAt: "2026-10-04T06:00:00Z",
  tracker: null,
  task: null,
  reporter: "Shlok",
  ...over,
});

const listed = (fileId: string) => ({
  fileId,
  name: fileId,
  state: "new",
  modifiedTime: null,
  trackers: 0,
  requestedBy: "Shlok",
});

async function render(items: AttentionItem[], files: unknown[]) {
  data.items = items;
  data.files = files;
  const { default: AttentionPage } =
    await import("@/app/(app)/admin/attention/page");
  return renderToStaticMarkup(await AttentionPage())
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

describe("New tracker requested (N86)", () => {
  it("shows under Knit what was asked, with Set up while the sheet is listed", async () => {
    const html = await render([request()], [listed(FILE)]);
    expect(html).toContain("New tracker requested");
    expect(html).toContain(
      'Shlok asks to connect "Brand Zeta": 10 tasks, in the Knit Standard Tracker v2 layout. 2 names in it are not known to Knit yet. Note: "For the Zeta launch"',
    );
    expect(html).toContain(`href="/admin/trackers/new/${FILE}"`);
    expect(html).toContain(">Set up<");
    expect(html).toContain(
      `href="https://docs.google.com/spreadsheets/d/${FILE}/edit"`,
    );
    expect(html).toContain(">Open the sheet<");
    expect(html.match(/>Dismiss</g)).toHaveLength(1);
    expect(html).not.toContain("The sheet is no longer in the Knit folder.");
  });

  it("says the sheet left the Knit folder instead of offering Set up", async () => {
    const html = await render([request()], []);
    expect(html).toContain("The sheet is no longer in the Knit folder.");
    expect(html).not.toContain(">Set up<");
    expect(html).toContain(">Open the sheet<");
  });

  it("keeps the plain Dismiss for other items only", async () => {
    const { setAttentionState, dismissTrackerRequest } =
      await import("@/lib/actions/admin");
    type Bindable = { bind: (...args: unknown[]) => unknown };
    const plain = vi.spyOn(setAttentionState as unknown as Bindable, "bind");
    const withReason = vi.spyOn(
      dismissTrackerRequest as unknown as Bindable,
      "bind",
    );
    const html = await render(
      [
        request(),
        request({
          id: 32,
          kind: "calendar_ending",
          detail: { last: "2027-12-31" },
          reporter: null,
        }),
      ],
      [listed(FILE)],
    );
    expect(plain.mock.calls).toEqual([[null, 32, "dismissed"]]);
    expect(withReason.mock.calls).toEqual([[null, 5]]);
    expect(html.match(/>Dismiss</g)).toHaveLength(2);
  });
});
