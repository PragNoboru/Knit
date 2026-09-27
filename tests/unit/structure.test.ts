import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { normaliseKey, TrackerConfig } from "@/lib/domain/config";
import {
  columnLetter,
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  type TabStructure,
} from "@/lib/sheets/types";
import { checkStructure } from "@/lib/sync/structure";

// PRD 10.2 step 2, 7.3, N6, D7, 14: the structure check that pull, push and the daily job share.

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../fixtures/trackers.config.json", import.meta.url),
    ),
    "utf8",
  ),
) as { trackers: { name: string }[] };
const config = TrackerConfig.parse(
  registry.trackers.find((t) => t.name === "Filing Buddy · Google Ads"),
);

const FILING_BUDDY = [
  "ID",
  "Date",
  "Phase",
  "Task",
  "Details / done when",
  "Owner",
  "Blocks go-live?",
  "Depends on",
  "Status",
  "Done on",
  "Notes",
  "Ref",
];

function structure(
  headers: string[],
  formulaColumns: string[] = [],
): TabStructure {
  const normalised = headers.map(normaliseKey);
  return {
    headers: headers.map((header, index) => ({
      index,
      letter: columnLetter(index),
      header,
      normalised: normalised[index]!,
    })),
    formulaColumns: formulaColumns.map(normaliseKey),
    validations: {},
    duplicateHeaders: normalised.filter((h, i) => normalised.indexOf(h) !== i),
  };
}

const knitColumns = [...FILING_BUDDY, KNIT_ID_HEADER, KNIT_NOTE_HEADER];

describe("checkStructure", () => {
  it("passes a tracker whose columns all match, with formulas only in columns Knit never writes", () => {
    expect(checkStructure(structure(knitColumns, ["Notes"]), config)).toBe(
      null,
    );
  });

  it("pauses when the Knit Note column is missing, naming it (D7: every write-back writes the note)", () => {
    expect(
      checkStructure(structure([...FILING_BUDDY, KNIT_ID_HEADER]), config),
    ).toEqual({
      kind: "missing_header",
      dedupeKey: "missing_header:knit note",
      reason: "the Knit Note column is missing",
      detail: { header: "Knit Note" },
    });
  });

  it("pauses when a Knit column appears twice", () => {
    expect(
      checkStructure(structure([...knitColumns, KNIT_ID_HEADER]), config),
    ).toMatchObject({
      kind: "missing_header",
      dedupeKey: "missing_header:knit id",
      reason: "column 'Knit ID' appears more than once",
    });
    expect(
      checkStructure(structure([...knitColumns, "knit  note"]), config),
    ).toMatchObject({
      kind: "missing_header",
      dedupeKey: "missing_header:knit note",
      reason: "column 'Knit Note' appears more than once",
    });
  });

  it("still reports a missing Knit ID column first, so it can be recreated (14)", () => {
    expect(
      checkStructure(structure([...FILING_BUDDY, KNIT_NOTE_HEADER]), config),
    ).toMatchObject({ kind: "missing_knit_id_column" });
  });

  it("pauses when a column Knit writes holds formulas, detected in the sheet (N6)", () => {
    for (const header of [
      "Status",
      "Done on",
      KNIT_ID_HEADER,
      KNIT_NOTE_HEADER,
    ])
      expect(checkStructure(structure(knitColumns, [header]), config)).toEqual({
        kind: "formula_column",
        dedupeKey: `formula_column:${normaliseKey(header)}`,
        reason: `column '${header}' holds formulas and cannot be written`,
        detail: { header },
      });
  });
});
