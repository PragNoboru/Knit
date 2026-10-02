import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import {
  KNIT_STANDARD_V1,
  KNIT_STANDARD_V2,
  matchStandardTemplate,
  STANDARD_TEMPLATES,
  standardFormulaProblem,
  standardSetupDraft,
  standardStatusesLeft,
  standardStatusNotices,
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
      ["Noboru_CA_Campaign_test_example", "Tasks"],
      ["Sapiens_Example_Tracker", "Calendar"],
    ] as const) {
      const tabs = await source.listTabs(file);
      // The tab trackers.config.json connects; a wrong name fails here, never falls back.
      expect(
        tabs.map((t) => t.title),
        file,
      ).toContain(title);
      const { structure: s } = await tab(file, title);
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

  it("lists every version once, newest first (N70, N74)", () => {
    const ids = STANDARD_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["knit-standard-v2", "knit-standard-v1"]);
    expect(KNIT_STANDARD_V1.headers).toHaveLength(14);
  });
});

describe("Knit Standard Tracker v2 (N74)", () => {
  const V2 = [...KNIT_STANDARD_V2.headers];

  it("is v1 with Maker right after Owner, columns A to O", () => {
    expect(V2).toEqual([
      "Task ID",
      "Date",
      "End date",
      "Task",
      "Details / done when",
      "Workstream",
      "Owner",
      "Maker",
      "Priority",
      "Status",
      "Stage",
      "Done on",
      "Depends on",
      "Link",
      "Notes",
    ]);
    // v1 never changes (N70).
    expect(V1).toEqual([
      "Task ID",
      "Date",
      "End date",
      "Task",
      "Details / done when",
      "Workstream",
      "Owner",
      "Priority",
      "Status",
      "Stage",
      "Done on",
      "Depends on",
      "Link",
      "Notes",
    ]);
    expect(KNIT_STANDARD_V1).toMatchObject({
      ownerHeader: "Owner",
      checkerHeader: null,
    });
  });

  it("matches v2's row 1 as v2 and v1's as v1, never the other way round", () => {
    expect(matched(structure([...V2, "Budget"])).template).toBe(
      KNIT_STANDARD_V2,
    );
    expect(matched(structure(V1)).template).toBe(KNIT_STANDARD_V1);
    // v1 with a Maker column after Notes is still v1: Maker is then a brand column.
    expect(matched(structure([...V1, "Maker"])).template).toBe(
      KNIT_STANDARD_V1,
    );
    // Maker anywhere else is neither.
    const makerFirst = ["Maker", ...V1];
    expect(matchStandardTemplate(structure(makerFirst))).toBe(null);
  });

  it("names v2 in its copy (11.1)", () => {
    expect(matchStandardTemplate(structure(V2, ["Status"]))?.problem).toBe(
      'This tab has the Knit Standard Tracker v2 columns, but "Status" holds formulas, so Knit cannot write to it. Set it up step by step.',
    );
  });

  it("maps Maker as the owner and Owner as the checking owner, the rest as v1 (N73, N74)", () => {
    const v1 = standardSetupDraft(
      matched(structure(V1)),
      structure(V1),
      [],
      [],
    ).patch;
    const v2 = standardSetupDraft(
      matched(structure(V2)),
      structure(V2),
      [],
      [],
    ).patch;
    expect(v1.columns).toMatchObject({ owner: "Owner", checker: null });
    expect(v2.columns).toMatchObject({ owner: "Maker", checker: "Owner" });
    expect({
      ...v2,
      columns: { ...v2.columns, owner: "Owner", checker: null },
    }).toEqual(v1);
  });

  it("gives exactly the registry of the v2 example, then opens Owners", async () => {
    const example = await tab("Knit_Standard_Tracker_v2_example", "Tasks");
    const match = matched(example.structure);
    expect(match.template).toBe(KNIT_STANDARD_V2);
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
      TrackerConfig.parse(entry("Knit Standard v2 · Example")),
    );
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

  // The merge into a saved draft (goLiveChosen kept) is tested on applyStandardSetup in
  // admin-actions.test.ts.
  it("leaves goLiveChosen out, clears cancel reasons and keeps at most 8 detail columns", () => {
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

  it("names a word not offered only while its write-back is still to choose (11.1)", () => {
    const words = ["Not started", "In progress", "Done", "Cancelled"];
    const choices = words.map((w) => word(w));
    const { patch } = standardSetupDraft(
      matched(structure(V1)),
      structure(V1),
      choices,
      words,
    );
    const notices = (writeBack: typeof patch.writeBack) =>
      standardStatusNotices(
        KNIT_STANDARD_V1,
        standardStatusesLeft(
          KNIT_STANDARD_V1,
          choices,
          patch.statusMap,
          words,
          writeBack,
        ),
        "Status",
      );
    expect(notices(patch.writeBack)).toEqual([
      'Standard setup applied. "Status" does not offer Blocked, so choose a write-back value for Blocked.',
    ]);
    // Step 5 saved with Leave unchanged for Blocked, then opened again with the flag.
    expect(notices({ ...patch.writeBack, blocked: null })).toEqual([]);
    expect(
      standardStatusesLeft(KNIT_STANDARD_V1, choices, patch.statusMap, words, {
        ...patch.writeBack,
        blocked: null,
      }).notOffered,
    ).toEqual([]);
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
