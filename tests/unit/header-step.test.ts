import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import { KNIT_STANDARD_V1 } from "@/lib/domain/standard-template";
import { columnLetter, type TabStructure } from "@/lib/sheets/types";

// PRD 11 step 3, 11.1, N68: the header row step offers Use the standard setup on a draft whose
// row 1 holds the standard headers, says why not when a write target holds formulas, and offers
// nothing on a live tracker or another layout.

const fx = vi.hoisted(() => ({ structure: null as unknown }));

vi.mock("@/lib/admin/data", () => ({
  loadTopRows: async () => [["Task ID", "Date"]],
  loadTabData: async () => ({ structure: fx.structure, rows: [] }),
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
  });

  it("offers Use the standard setup on a draft in the standard layout", async () => {
    const html = await render("draft");
    expect(html).toContain("This tab follows the Knit Standard Tracker v1.");
    expect(html).toContain("Use the standard setup");
    expect(html).toContain("Which row holds the column names?");
  });

  it("names a write target holding formulas, with no button", async () => {
    fx.structure = structure(KNIT_STANDARD_V1.headers, ["status"]);
    const html = await render("draft");
    expect(html).toContain(
      "This tab has the Knit Standard Tracker v1 columns, but &quot;Status&quot; holds formulas, so Knit cannot write to it. Set it up step by step.",
    );
    expect(html).not.toContain("Use the standard setup");
  });

  it("offers nothing on a live tracker or another layout", async () => {
    expect(await render("active")).not.toContain("Knit Standard Tracker");
    fx.structure = structure(["ID", "Date", "Task", "Status"]);
    expect(await render("draft")).not.toContain("Knit Standard Tracker");
  });
});
