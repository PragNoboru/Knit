import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import {
  KNIT_STANDARD_V1,
  KNIT_STANDARD_V2,
} from "@/lib/domain/standard-template";
import { columnLetter, type TabStructure } from "@/lib/sheets/types";

// PRD 11 step 3, 11.1, N68: the header row step offers Use the standard setup on a draft whose
// row 1 holds the standard headers, says why not when a write target holds formulas, and offers
// nothing on a live tracker or another layout.

const fx = vi.hoisted(() => ({
  structure: null as unknown,
  structureError: null as Error | null,
  reads: [] as string[],
}));

vi.mock("@/lib/admin/data", () => ({
  loadTopRows: async () => [["Task ID", "Date"]],
  loadStructure: async () => {
    fx.reads.push("structure");
    if (fx.structureError) throw fx.structureError;
    return fx.structure;
  },
  loadTabData: async () => {
    fx.reads.push("rows");
    return { structure: fx.structure, rows: [] };
  },
  loadSheetDeps: async () => ({ store: { today: async () => "2026-09-30" } }),
}));
vi.mock("@/lib/actions/admin", () => ({
  applyStandardSetup: vi.fn(),
  saveHeaderRow: vi.fn(),
}));

function structure(headers: readonly string[], formula: string[] = []) {
  return {
    headers: headers.map((header, index) => ({
      index,
      letter: columnLetter(index),
      header,
      normalised: header.toLowerCase(),
    })),
    formulaColumns: formula,
    validations: {},
    duplicateHeaders: [],
  } satisfies TabStructure;
}

async function render(state: AdminTracker["state"]) {
  const { HeaderStep } =
    await import("@/app/(app)/admin/trackers/_parts/steps/header");
  const tracker = {
    id: "00000000-0000-4000-8000-0000000000f3",
    state,
    draft: {},
    ref: { fileId: "sheet-1", sheetId: 0 },
  } as unknown as AdminTracker;
  return renderToStaticMarkup(await HeaderStep({ tracker }));
}

describe("Header row step: the standard setup (11.1)", () => {
  beforeEach(() => {
    fx.structure = structure([...KNIT_STANDARD_V1.headers, "Budget"]);
    fx.structureError = null;
    fx.reads = [];
  });

  it("offers Use the standard setup on a draft in the standard layout", async () => {
    const html = await render("draft");
    expect(html).toContain("This tab follows the Knit Standard Tracker v1.");
    expect(html).toContain("Use the standard setup");
    expect(html).toContain("Which row holds the column names?");
  });

  it("names the newest version row 1 matches: v2 for its 15 headers (N74)", async () => {
    fx.structure = structure([...KNIT_STANDARD_V2.headers, "Budget"]);
    const html = await render("draft");
    expect(html).toContain("This tab follows the Knit Standard Tracker v2.");
    expect(html).not.toContain("Knit Standard Tracker v1");
    expect(html).toContain("Use the standard setup");
  });

  it("names a write target holding formulas, with no button", async () => {
    fx.structure = structure(KNIT_STANDARD_V1.headers, ["status"]);
    const html = await render("draft");
    expect(html).toContain(
      "This tab has the Knit Standard Tracker v1 columns, but &quot;Status&quot; holds formulas, so Knit cannot write to it. Set it up step by step.",
    );
    expect(html).not.toContain("Use the standard setup");
  });

  it("reads row 1's structure only, not the tab's rows", async () => {
    await render("draft");
    expect(fx.reads).toEqual(["structure"]);
  });

  it("still shows the header rows, with no offer, when row 1 cannot be read", async () => {
    fx.structureError = new Error("quota");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const html = await render("draft");
    log.mockRestore();
    expect(html).toContain("Which row holds the column names?");
    expect(html).not.toContain("Knit Standard Tracker");
  });

  it("offers nothing on a live tracker or another layout", async () => {
    expect(await render("active")).not.toContain("Knit Standard Tracker");
    fx.structure = structure(["ID", "Date", "Task", "Status"]);
    expect(await render("draft")).not.toContain("Knit Standard Tracker");
  });
});
