import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import {
  KNIT_STANDARD_V1,
  standardNotOffered,
  standardWordsLeft,
} from "@/lib/domain/standard-template";
import { STATUSES_LIVE_HINT } from "@/lib/domain/wizard";

// PRD 11 (Editing a live tracker's mapping later), N28, N60: the statuses step of a live
// tracker says that a remapped word reaches only new rows and rows that change to it. Not on a
// draft, and not while the status columns are being changed (N42), where the new column's
// words are changes made in the source.

const text = (v: string) => ({ value: v, formatted: v });

const fx = vi.hoisted(() => ({ tab: null as unknown }));
const defaultTab = {
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
};

vi.mock("@/lib/admin/data", () => ({
  loadTabData: async () => fx.tab,
}));
beforeEach(() => {
  fx.tab = defaultTab;
});
vi.mock("@/lib/actions/admin", () => ({ saveStatuses: vi.fn() }));

function tracker(
  state: AdminTracker["state"],
  draft: Partial<AdminTracker["draft"]> = {},
): AdminTracker {
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
      ...draft,
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
  options: { draft?: Partial<AdminTracker["draft"]>; standard?: boolean } = {},
) {
  const { StatusesStep } =
    await import("@/app/(app)/admin/trackers/_parts/steps/statuses");
  return renderToStaticMarkup(
    await StatusesStep({
      tracker: tracker(state, options.draft),
      pending,
      standard: options.standard,
    }),
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

describe("Statuses step: a mapped blank (N69, amends N19 a)", () => {
  it("lists (blank) with 0 rows when the status map maps it, though no row is blank", async () => {
    const html = await render("draft", null, {
      draft: { statusMap: { done: "done", "": "yet_to_start" } },
    });
    expect(html).toMatch(/\(blank\)[\s\S]*?<td class="tabular-nums">0<\/td>/);
  });

  it("does not list a blank that is neither mapped nor in use", async () => {
    expect(await render("draft")).not.toContain("(blank)");
  });
});

describe("Statuses step after the standard setup (11.1, N69)", () => {
  const headers = KNIT_STANDARD_V1.headers.map((header, index) => ({
    index,
    letter: String.fromCharCode(65 + index),
    header,
    normalised: header.toLowerCase(),
  }));
  const standardDraft = {
    statusMap: {
      "": "yet_to_start",
      "not started": "yet_to_start",
      "in progress": "in_progress",
      blocked: "blocked",
      done: "done",
      cancelled: "cancelled",
    },
    writeBack: {
      yet_to_start: "Not started",
      in_progress: "In progress",
      blocked: "Blocked",
      done: "Done",
      cancelled: "Cancelled",
    },
  } as Partial<AdminTracker["draft"]>;

  it("names the words the standard list does not cover, worked out from the tab", async () => {
    fx.tab = {
      structure: {
        headers,
        formulaColumns: [],
        duplicateHeaders: [],
        validations: {},
      },
      rows: ["Not started", "Done", "Skipped"].map((word, i) => ({
        rowNumber: i + 2,
        cells: { status: text(word) },
      })),
    };
    const html = await render("draft", null, {
      draft: standardDraft,
      standard: true,
    });
    expect(html).toContain(standardWordsLeft(["Skipped"]));
    // Without the flag, or with nothing left, no notice.
    expect(await render("draft", null, { draft: standardDraft })).not.toContain(
      "Standard setup applied",
    );
  });

  // No dropdown, and nobody uses Blocked: the column does not offer it.
  const noBlocked = () => {
    fx.tab = {
      structure: {
        headers,
        formulaColumns: [],
        duplicateHeaders: [],
        validations: {},
      },
      rows: ["Not started", "In progress", "Done", "Cancelled"].map(
        (word, i) => ({ rowNumber: i + 2, cells: { status: text(word) } }),
      ),
    };
  };
  const withoutBlocked = Object.fromEntries(
    Object.entries(standardDraft.writeBack!).filter(([s]) => s !== "blocked"),
  ) as NonNullable<AdminTracker["draft"]["writeBack"]>;

  it("names a word the column does not offer while its write-back is still to choose", async () => {
    noBlocked();
    const html = await render("draft", null, {
      draft: { ...standardDraft, writeBack: withoutBlocked },
      standard: true,
    });
    expect(html).toContain(
      standardNotOffered("Status", ["Blocked"], ["blocked"]).replaceAll(
        '"',
        "&quot;",
      ),
    );
    expect(html).toContain('name="standard" value="applied"');
  });

  it("says nothing about it once that write-back is chosen, so the list is never empty", async () => {
    noBlocked();
    const html = await render("draft", null, {
      draft: {
        ...standardDraft,
        writeBack: { ...withoutBlocked, blocked: null },
      },
      standard: true,
    });
    expect(html).not.toContain("does not offer");
    expect(html).not.toContain("write-back value for .");
    // The flag still reaches step 6.
    expect(html).toContain('name="standard" value="applied"');
  });

  it("does not hand the flag on when the page was not opened by the preset", async () => {
    noBlocked();
    const html = await render("draft", null, { draft: standardDraft });
    expect(html).not.toContain('name="standard"');
  });
});
