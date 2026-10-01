import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import {
  KNIT_STANDARD_V1,
  matchStandardTemplate,
  STANDARD_TEMPLATES,
  standardFormulaProblem,
  standardSetupDraft,
  standardStatusesLeft,
  type StandardMatch,
} from "@/lib/domain/standard-template";
import { renderTemplate } from "@/lib/domain/templates";
import {
  finalConfig,
  statusChoices,
  writeBackOptions,
  type StatusChoice,
} from "@/lib/domain/wizard";
import { MemorySheetSource } from "@/lib/sheets/memory";
import { columnLetter, type TabStructure } from "@/lib/sheets/types";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD 11.1, N68 to N70: when the wizard offers Use the standard setup, and what it saves.

const registry = (
  await import("../../fixtures/trackers.config.json", {
    with: { type: "json" },
  })
).default as { trackers: Record<string, unknown>[] };
const entry = (name: string) => registry.trackers.find((t) => t.name === name)!;

const source = new MemorySheetSource(
  loadXlsxFolder(
    fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
  ),
);

async function tab(fileId: string, title: string, headerRow = 1) {
  const sheetId = (await source.listTabs(fileId)).find(
    (t) => t.title === title,
  )!.sheetId;
  const ref = { fileId, sheetId };
  return {
    structure: await source.readStructure(ref, headerRow),
    rows: await source.readRows(ref, headerRow),
  };
}

function structure(
  headers: string[],
  formulaColumns: string[] = [],
): TabStructure {
  const normalised = headers.map(normaliseKey);
  return {
    headers: headers.flatMap((header, index) =>
      header === ""
        ? []
        : [
            {
              index,
              letter: columnLetter(index),
              header,
              normalised: normalised[index]!,
            },
          ],
    ),
    formulaColumns: formulaColumns.map(normaliseKey),
    validations: {},
    duplicateHeaders: normalised.filter(
      (h, i) => h !== "" && normalised.indexOf(h) !== i,
    ),
  };
}

const V1 = [...KNIT_STANDARD_V1.headers];
const matched = (s: TabStructure) => {
  const match = matchStandardTemplate(s);
  if (!match || match.problem !== null) throw new Error("expected a match");
  return match as Extract<StandardMatch, { problem: null }>;
};

describe("matchStandardTemplate (N68)", () => {
  it("matches the 14 headers in A1 to N1, whatever their case and spacing", () => {
    expect(matchStandardTemplate(structure(V1))).toMatchObject({
      template: KNIT_STANDARD_V1,
      problem: null,
    });
    const loose = V1.map((h, i) =>
      i % 2 === 0 ? `  ${h.toUpperCase()} ` : h.replace(" ", "  "),
    );
    const match = matched(structure(loose));
    // Headers are saved as the sheet spells them.
    expect(match.headers["task id"]).toBe(loose[0]);
  });

  it("allows brand columns, Knit ID and Knit Note after Notes", () => {
    expect(
      matchStandardTemplate(
        structure([...V1, "Budget", "", "Region", "Knit ID", "Knit Note"]),
      ),
    ).toMatchObject({ problem: null });
  });

  it("does not match a reordered row, a column between standard columns, or one missing or renamed", () => {
    const swapped = [...V1];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    const between = [...V1.slice(0, 5), "Budget", ...V1.slice(5)];
    const missing = V1.filter((h) => h !== "Link");
    const renamed = V1.map((h) =>
      h === "Details / done when" ? "Details/done when" : h,
    );
    const gap = [...V1.slice(0, 3), "", ...V1.slice(3)];
    const titleRowAbove = ["Brand tracker", ...V1];
    for (const headers of [
      swapped,
      between,
      missing,
      renamed,
      gap,
      titleRowAbove,
    ])
      expect(matchStandardTemplate(structure(headers))).toBe(null);
  });

  it("does not match when a standard header repeats after Notes", () => {
    expect(matchStandardTemplate(structure([...V1, "Owner"]))).toBe(null);
  });

  it("does not match the four real example trackers", async () => {
    for (const [file, title] of [
      ["Filing_Buddy_Google_Ads_Tracker", "Copy of Google"],
      ["Filing_Buddy_Meta_Ads_Tracker", "Copy of Meta"],
      ["Noboru_CA_Campaign_test_example", "Sheet1"],
      ["Sapiens_Example_Tracker", "Calendar"],
    ] as const) {
      const tabs = await source.listTabs(file);
      const found = tabs.find((t) => t.title === title) ?? tabs[0]!;
      const { structure: s } = await tab(file, found.title);
      expect(matchStandardTemplate(s), file).toBe(null);
    }
  });

  it("names a write target holding formulas instead of offering the button (N6)", () => {
    expect(matchStandardTemplate(structure(V1, ["Status"]))).toEqual({
      template: KNIT_STANDARD_V1,
      headers: null,
      problem: standardFormulaProblem(KNIT_STANDARD_V1, "Status"),
    });
    expect(matchStandardTemplate(structure(V1, ["Done on"]))?.problem).toBe(
      'This tab has the Knit Standard Tracker v1 columns, but "Done on" holds formulas, so Knit cannot write to it. Set it up step by step.',
    );
    // Knit only reads End date and the other columns.
    expect(
      matchStandardTemplate(structure(V1, ["End date", "Notes"]))?.problem,
    ).toBe(null);
  });

  it("lists every version once, newest first (N70)", () => {
    const ids = STANDARD_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("knit-standard-v1");
    expect(KNIT_STANDARD_V1.headers).toHaveLength(14);
  });
});

describe("standardSetupDraft (11.1, N69)", () => {
  const word = (w: string, count = 1, inDropdown = false): StatusChoice => ({
    key: normaliseKey(w),
    word: w,
    count,
    inDropdown,
  });

  it("gives exactly the registry of the standard example, then opens Owners", async () => {
    const example = await tab("Knit_Standard_Tracker_v1_example", "Tasks");
    const match = matched(example.structure);
    const dropdown = example.structure.validations.status?.options ?? null;
    const { patch, next } = standardSetupDraft(
      match,
      example.structure,
      statusChoices(example.rows, "Status", dropdown),
      writeBackOptions(example.rows, "Status", dropdown),
    );
    expect(next).toBe("owners");
    const config = finalConfig({ ...patch, goLiveChosen: true });
    expect(config.success && config.data).toEqual(
      TrackerConfig.parse(entry("Knit Standard · Example")),
    );
  });

  it("keeps goLiveChosen and clears cancel reasons; at most 8 detail columns", () => {
    const match = matched(structure(V1));
    const { patch } = standardSetupDraft(
      match,
      structure(V1),
      [],
      ["Not started", "In progress", "Blocked", "Done", "Cancelled"],
    );
    expect(patch).not.toHaveProperty("goLiveChosen");
    expect(patch.cancelReasons).toEqual({});
    expect(patch.detailColumns!.length).toBeLessThanOrEqual(8);
    const draft = {
      goLiveChosen: true,
      cancelReasons: { skipped: "Dropped" },
      ...patch,
    };
    expect(draft.goLiveChosen).toBe(true);
    expect(draft.cancelReasons).toEqual({});
  });

  it("opens Map statuses when the column holds a word outside the five, and names it", () => {
    const match = matched(structure(V1));
    const choices = [
      word("Not started", 0, true),
      word("In progress", 0, true),
      word("Blocked", 0, true),
      word("Done", 0, true),
      word("Cancelled", 0, true),
      word("Skipped", 2),
    ];
    const words = choices.filter((c) => c.inDropdown).map((c) => c.word);
    const { patch, next } = standardSetupDraft(
      match,
      structure(V1),
      choices,
      words,
    );
    expect(next).toBe("statuses");
    expect(
      standardStatusesLeft(
        KNIT_STANDARD_V1,
        choices,
        patch.statusMap,
        words,
        patch.writeBack,
      ),
    ).toEqual({
      wordsToMap: ["Skipped"],
      notOffered: [],
      writeBacksToChoose: [],
    });
  });

  it("writes back in the spelling the Status column offers", () => {
    const words = [
      "Not Started",
      "In Progress",
      "Blocked",
      "Done",
      "Cancelled",
    ];
    const { patch, next } = standardSetupDraft(
      matched(structure(V1)),
      structure(V1),
      words.map((w) => word(w, 0, true)),
      words,
    );
    expect(patch.writeBack).toMatchObject({
      yet_to_start: "Not Started",
      in_progress: "In Progress",
    });
    expect(patch.statusMap).toMatchObject({
      "not started": "yet_to_start",
      "": "yet_to_start",
    });
    expect(next).toBe("owners");
  });

  it("leaves a write-back unset, and opens Map statuses, when the column does not offer the word", () => {
    // No dropdown, and nobody uses Blocked yet: the words found are all that is offered.
    const words = ["Not started", "In progress", "Done", "Cancelled"];
    const choices = words.map((w) => word(w));
    const { patch, next } = standardSetupDraft(
      matched(structure(V1)),
      structure(V1),
      choices,
      words,
    );
    expect(patch.writeBack?.blocked).toBeUndefined();
    expect(next).toBe("statuses");
    expect(
      standardStatusesLeft(
        KNIT_STANDARD_V1,
        choices,
        patch.statusMap,
        words,
        patch.writeBack,
      ),
    ).toEqual({
      wordsToMap: [],
      notOffered: ["Blocked"],
      writeBacksToChoose: ["blocked"],
    });
  });

  it("records the tab's formula columns as read-only", () => {
    const s = structure([...V1, "Budget"], ["Budget"]);
    const { patch } = standardSetupDraft(matched(s), s, [], []);
    expect(patch.readOnlyColumns).toEqual(["Budget"]);
  });

  it("renders the subtitle with blank parts left out", () => {
    const { patch } = standardSetupDraft(
      matched(structure(V1)),
      structure(V1),
      [],
      [],
    );
    const subtitle = (values: Record<string, string>) =>
      renderTemplate(patch.subtitleTemplate!, (h) => values[h]) || null;
    expect(
      subtitle({ "task id": "FBG-21", workstream: "Ads", stage: "Build" }),
    ).toBe("FBG-21 · Ads · Build");
    expect(subtitle({ "task id": "FBG-21", stage: "Build" })).toBe(
      "FBG-21 · Build",
    );
    expect(subtitle({ workstream: "Ads", stage: "Build" })).toBe("Ads · Build");
    expect(subtitle({})).toBe(null);
  });
});
