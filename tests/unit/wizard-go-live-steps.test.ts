import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import { calendarDaysFromRules, type CalendarDay } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import {
  GO_LIVE_NEEDS_A_DATE,
  previewStats,
  type DraftConfig,
} from "@/lib/domain/wizard";
import { MemorySheetSource } from "@/lib/sheets/memory";
import type { TabRef } from "@/lib/sheets/types";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD 11 steps 7 to 9, N42: the go-live the wizard's screens show and use. Until a date is saved
// at step 7 it is the next working day after today; with no calendar day for it there is none,
// and step 7, the preview and the activate step ask for a date. Only the jobs' store and sheet
// source are faked (the example tracker in memory), so these run the real loaders in
// lib/admin/data.ts.

const fx = vi.hoisted(() => ({
  today: "2026-09-30",
  calendar: [] as unknown[],
  /** How many times the store was asked for today and the calendar. */
  reads: 0,
  source: null as unknown,
}));

vi.mock("@/lib/jobs/cron", () => ({
  jobDeps: async () => ({
    store: {
      today: async () => {
        fx.reads += 1;
        return fx.today;
      },
      loadContext: async () => {
        fx.reads += 1;
        return { calendar: fx.calendar, aliases: [] };
      },
    },
    source: fx.source,
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  callRpc: vi.fn(),
  getSupabase: vi.fn(),
}));
vi.mock("@/lib/actions/admin", () => ({
  activateTracker: vi.fn(),
  saveDetails: vi.fn(),
}));

const { currentGoLive, loadNormalisedRows } = await import("@/lib/admin/data");
const { DetailsStep } =
  await import("@/app/(app)/admin/trackers/_parts/steps/details");
const { PreviewStep } =
  await import("@/app/(app)/admin/trackers/_parts/steps/preview");
const { ActivateStep } =
  await import("@/app/(app)/admin/trackers/_parts/steps/activate");

const registry = (
  await import("../../fixtures/trackers.config.json", {
    with: { type: "json" },
  })
).default as { trackers: Record<string, unknown>[] };
const META = TrackerConfig.parse(
  registry.trackers.find((t) => t.name === "Filing Buddy · Meta Ads"),
);
const source = new MemorySheetSource(
  loadXlsxFolder(
    fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
  ),
);
const FILE = "Filing_Buddy_Meta_Ads_Tracker";
const ref: TabRef = {
  fileId: FILE,
  sheetId: (await source.listTabs(FILE)).find(
    (t) => t.title === "Copy of Meta",
  )!.sheetId,
};
const holidays = (
  await import("../../fixtures/holidays.json", { with: { type: "json" } })
).default.holidays;
const calendarTo = (last: string): CalendarDay[] =>
  calendarDaysFromRules(holidays, "2026-09-01", last);

/** A draft of the Meta Ads tab with every step done; go-live holds startSetup's placeholder. */
function tracker(
  over: { state?: AdminTracker["state"]; draft?: Partial<DraftConfig> } = {},
): AdminTracker {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    fileId: FILE,
    gid: ref.sheetId,
    tabName: "Copy of Meta",
    name: "Meta Ads",
    color: "amber",
    state: over.state ?? "draft",
    pauseReason: null,
    draft: { ...META, ...over.draft },
    goLiveDate: "2026-09-28",
    lastPullAt: null,
    ownerUserId: null,
    ref,
  };
}
const SAVED = { draft: { goLiveChosen: true } };

beforeEach(() => {
  fx.today = "2026-09-30";
  fx.calendar = calendarTo("2026-12-31");
  fx.reads = 0;
  fx.source = source;
});

describe("the go-live the wizard uses (N42)", () => {
  it("is the next working day for a draft with no saved date, else none", async () => {
    expect(await currentGoLive(tracker())).toBe("2026-10-01");
    fx.calendar = calendarTo("2026-09-30");
    expect(await currentGoLive(tracker())).toBeNull();
  });

  it("is the saved or live date as it is, without reading today or the calendar", async () => {
    expect(await currentGoLive(tracker(SAVED))).toBe("2026-09-28");
    expect(await currentGoLive(tracker({ state: "active" }))).toBe(
      "2026-09-28",
    );
    expect(fx.reads).toBe(0);
  });

  it("is what the preview's rows come with, not startSetup's placeholder", async () => {
    expect((await loadNormalisedRows(tracker()))?.goLive).toBe("2026-10-01");
    expect((await loadNormalisedRows(tracker(SAVED)))?.goLive).toBe(
      "2026-09-28",
    );
    fx.calendar = calendarTo("2026-09-30");
    expect((await loadNormalisedRows(tracker()))?.goLive).toBeNull();
  });
});

const render = async (element: Promise<React.ReactElement>) =>
  renderToStaticMarkup(await element);

describe("step 7: the go-live date and its hint (N42)", () => {
  const input = (html: string) =>
    /<input[^>]*id="goLive"[^>]*>/.exec(html)?.[0] ?? "";

  it("shows the default with the default's hint", async () => {
    const html = await render(DetailsStep({ tracker: tracker() }));
    expect(input(html)).toContain('value="2026-10-01"');
    expect(html).toContain(
      "Defaults to the next working day. Rows due before this date, today&#x27;s included, are history only",
    );
  });

  it("leaves the date empty and asks for one when the calendar has no next working day", async () => {
    fx.calendar = calendarTo("2026-09-30");
    const html = await render(DetailsStep({ tracker: tracker() }));
    expect(input(html)).toContain('value=""');
    expect(html).toContain(
      "The working-day calendar does not reach the next working day yet, so choose a date.",
    );
  });

  it("describes a saved date neutrally, as it may be any date", async () => {
    const html = await render(DetailsStep({ tracker: tracker(SAVED) }));
    expect(input(html)).toContain('value="2026-09-28"');
    expect(html).toContain(
      "Rows due before this date are history only; the backlog review can bring them forward.",
    );
    expect(html).not.toContain("Defaults to the next working day");
    expect(html).not.toContain("today&#x27;s included");
    expect(fx.reads).toBe(0);
  });
});

describe("step 8: the preview uses the go-live activation would use (N42)", () => {
  const historyOnly = (html: string) =>
    Number(
      /Before go-live \(history only\)<\/dt><dd[^>]*>(\d+)</.exec(html)?.[1],
    );

  it("counts rows due before the next working day as history only", async () => {
    const rows = (await loadNormalisedRows(tracker()))!.rows;
    const expected = previewStats(rows, "2026-10-01").historyOnly;
    // The placeholder would give another count, so this tells the two apart.
    expect(previewStats(rows, "2026-09-28").historyOnly).not.toBe(expected);
    const html = await render(PreviewStep({ tracker: tracker() }));
    expect(historyOnly(html)).toBe(expected);
  });

  it("asks for a date at step 7 when there is no default", async () => {
    fx.calendar = calendarTo("2026-09-30");
    const html = await render(PreviewStep({ tracker: tracker() }));
    expect(html).toContain(GO_LIVE_NEEDS_A_DATE);
    expect(html).not.toContain("Before go-live (history only)");
  });
});

describe("step 9: activation needs a go-live (N42)", () => {
  const activateButton = /<button[^>]*>Activate</;

  it("offers Activate when there is a default", async () => {
    const html = await render(ActivateStep({ tracker: tracker() }));
    expect(html).toMatch(activateButton);
    expect(html).not.toContain(GO_LIVE_NEEDS_A_DATE);
  });

  it("lists the missing date, linked to step 7, and hides Activate when there is none", async () => {
    fx.calendar = calendarTo("2026-09-30");
    const html = await render(ActivateStep({ tracker: tracker() }));
    expect(html).toContain(GO_LIVE_NEEDS_A_DATE);
    expect(html).toMatch(
      /href="\/admin\/trackers\/[0-9a-f-]{36}\/setup\/details"[^>]*>Name, colour, go-live</,
    );
    expect(html).not.toMatch(activateButton);
  });

  it("does not read today or the calendar for a saved date", async () => {
    fx.calendar = calendarTo("2026-09-30");
    const html = await render(ActivateStep({ tracker: tracker(SAVED) }));
    expect(html).toMatch(activateButton);
    expect(fx.reads).toBe(0);
  });
});
