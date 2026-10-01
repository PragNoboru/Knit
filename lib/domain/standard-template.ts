import type { TabStructure } from "@/lib/sheets/types";

import { normaliseKey, USER_STATUSES, type UserStatus } from "./config";
import { STATUS_LABELS } from "./status";
import type { DraftConfig, StatusChoice } from "./wizard";

/**
 * PRD 11.1, N68 to N70: the standard tracker templates and the setup they fill in one go. Each
 * version is a fixed definition, added beside the others and never changed in place (N70). The
 * preset only fills a draft: a tracker's saved registry records no template, so a new version
 * never changes a connected tracker. Pure; the wizard's action reads the tab and saves.
 */

export interface StandardTemplate {
  id: string;
  name: string;
  /** Row 1, columns A onwards, in order. Brand columns may follow the last one. */
  headers: readonly string[];
  /** The status word the template uses for each Knit status. */
  statusWords: Readonly<Record<UserStatus, string>>;
  /** What a blank Status cell means. */
  blankStatus: UserStatus;
  /** The columns Knit writes, which may not hold formulas (N6). */
  writeTargets: readonly string[];
}

/** 11.1: Knit Standard Tracker v1, the template every brand's tracker uses from Phase 2. */
export const KNIT_STANDARD_V1: StandardTemplate = {
  id: "knit-standard-v1",
  name: "Knit Standard Tracker v1",
  headers: [
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
  ],
  statusWords: {
    yet_to_start: "Not started",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
  },
  blankStatus: "yet_to_start",
  writeTargets: ["Status", "Done on"],
};

/** Every template version, newest first: the wizard offers the newest one row 1 matches (N70). */
export const STANDARD_TEMPLATES: readonly StandardTemplate[] = [
  KNIT_STANDARD_V1,
];

export const STANDARD_TEMPLATE_IDS = STANDARD_TEMPLATES.map((t) => t.id);

// ---------------------------------------------------------------------------------------
// Copy (PRD 11.1)

export const STANDARD_BUTTON = "Use the standard setup";
export const STANDARD_TEXT =
  "Knit can fill in the columns, statuses and write-back words in one go. You then check owners, name, colour and go-live, and can still change any step.";
export const standardHeading = (template: StandardTemplate) =>
  `This tab follows the ${template.name}.`;
export const standardFormulaProblem = (
  template: StandardTemplate,
  header: string,
) =>
  `This tab has the ${template.name} columns, but "${header}" holds formulas, so Knit cannot write to it. Set it up step by step.`;
export const STANDARD_APPLIED_OWNERS =
  "Standard setup applied. Check the owners, then name, colour and go-live.";
export const standardWordsLeft = (words: readonly string[]) =>
  `Standard setup applied. Choose a Knit status for the words that are not in the standard list: ${words.join(", ")}.`;
export const standardNotOffered = (
  statusColumn: string,
  words: readonly string[],
  statuses: readonly UserStatus[],
) =>
  `Standard setup applied. "${statusColumn}" does not offer ${words.join(", ")}, so choose a write-back value for ${statuses
    .map((status) => STATUS_LABELS[status])
    .join(", ")}.`;
export const standardTabChanged = (template: StandardTemplate) =>
  `This tab no longer has the ${template.name} columns in row 1. Set it up step by step.`;
export const STANDARD_NOT_DRAFT =
  "Only a tracker being set up can use the standard setup.";

// ---------------------------------------------------------------------------------------
// Matching row 1 (N68)

export type StandardMatch =
  | {
      template: StandardTemplate;
      /** The template's headers as the sheet spells them, by normalised header. */
      headers: Record<string, string>;
      problem: null;
    }
  | { template: StandardTemplate; headers: null; problem: string };

/**
 * N68: row 1 begins with every header of a standard template in its order (A1 onwards,
 * normalised as the structure check matches headers), no later cell of row 1 repeats one of
 * them, and neither write target holds formulas. Columns after the template's last header do
 * not matter. The newest matching version wins; null when none matches. A match whose write
 * target holds formulas carries the sentence to show instead of the button.
 */
export function matchStandardTemplate(
  structure: Pick<
    TabStructure,
    "headers" | "duplicateHeaders" | "formulaColumns"
  >,
): StandardMatch | null {
  for (const template of STANDARD_TEMPLATES) {
    const headers: Record<string, string> = {};
    const inOrder = template.headers.every((expected, index) => {
      const found = structure.headers.find((h) => h.index === index);
      if (!found || found.normalised !== normaliseKey(expected)) return false;
      headers[found.normalised] = found.header;
      return true;
    });
    if (!inOrder) continue;
    const repeated = template.headers.some((header) =>
      structure.duplicateHeaders.includes(normaliseKey(header)),
    );
    if (repeated) continue;
    const formula = template.writeTargets.find((target) =>
      structure.formulaColumns.includes(normaliseKey(target)),
    );
    if (formula)
      return {
        template,
        headers: null,
        problem: standardFormulaProblem(
          template,
          headers[normaliseKey(formula)] ?? formula,
        ),
      };
    return { template, headers, problem: null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// What the preset fills (11.1, N69)

export interface StandardStatusesLeft {
  /** Words in the Status column (its rows and dropdown) the status map does not cover. */
  wordsToMap: string[];
  /** The template's words the Status column does not offer, as the template spells them. */
  notOffered: string[];
  /** Knit statuses still without a write-back value. */
  writeBacksToChoose: UserStatus[];
}

/** N69: what is left for step 5 after the preset, worked out from the tab and the draft. */
export function standardStatusesLeft(
  template: StandardTemplate,
  choices: readonly StatusChoice[],
  statusMap: Readonly<Record<string, UserStatus>> | undefined,
  writeWords: readonly string[],
  writeBack: DraftConfig["writeBack"],
): StandardStatusesLeft {
  const offered = new Set(writeWords.map(normaliseKey));
  return {
    wordsToMap: choices
      .filter((choice) => statusMap?.[choice.key] === undefined)
      .map((choice) => (choice.word === "" ? "(blank)" : choice.word)),
    notOffered: USER_STATUSES.map((s) => template.statusWords[s]).filter(
      (word) => !offered.has(normaliseKey(word)),
    ),
    writeBacksToChoose: USER_STATUSES.filter(
      (status) => writeBack?.[status] === undefined,
    ),
  };
}

const anyLeft = (left: StandardStatusesLeft) =>
  left.wordsToMap.length > 0 ||
  left.notOffered.length > 0 ||
  left.writeBacksToChoose.length > 0;

/**
 * 11.1, N69: the draft the preset saves. It fills the header row, columns, read-only columns,
 * templates, detail columns, statuses (the five words and a blank cell, nothing else),
 * write-back words in the spelling the Status column offers (its dropdown, else the words in
 * it), no cancel reasons, Done on as a real date and the owner policies. Name, colour and
 * go-live are not part of it. `next` is step 6, Owners and policies, or step 5, Map statuses,
 * when a word or a write-back value is left.
 */
export function standardSetupDraft(
  match: Extract<StandardMatch, { problem: null }>,
  structure: Pick<TabStructure, "headers" | "formulaColumns">,
  choices: readonly StatusChoice[],
  writeWords: readonly string[],
): { patch: Partial<DraftConfig>; next: "owners" | "statuses" } {
  const { template } = match;
  const h = (header: string) => match.headers[normaliseKey(header)] ?? header;
  const statusMap: Record<string, UserStatus> = { "": template.blankStatus };
  for (const status of USER_STATUSES)
    statusMap[normaliseKey(template.statusWords[status])] = status;
  const writeBack: NonNullable<DraftConfig["writeBack"]> = {};
  for (const status of USER_STATUSES) {
    const key = normaliseKey(template.statusWords[status]);
    const word = writeWords.find((w) => normaliseKey(w) === key);
    if (word !== undefined) writeBack[status] = word;
  }
  const formula = new Set(structure.formulaColumns);
  const patch: Partial<DraftConfig> = {
    headerRow: 1,
    columns: {
      date: h("Date"),
      endDate: h("End date"),
      title: h("Task"),
      statusRead: h("Status"),
      statusWrite: h("Status"),
      completedOn: h("Done on"),
      owner: h("Owner"),
      sourceRef: h("Task ID"),
      critical: { header: h("Priority"), truthy: ["High"] },
    },
    readOnlyColumns: structure.headers
      .filter((column) => formula.has(column.normalised))
      .map((column) => column.header),
    titleTemplate: `{${h("Task")}}`,
    subtitleTemplate: `{${h("Task ID")}} · {${h("Workstream")}} · {${h("Stage")}}`,
    detailColumns: [
      h("Details / done when"),
      h("Workstream"),
      h("Stage"),
      h("Priority"),
      h("Depends on"),
      h("Link"),
      h("Notes"),
    ],
    ownerSeparators: [","],
    ownerFilter: "mine",
    offDayPolicy: "previous_working_day",
    statusMap,
    cancelReasons: {},
    writeBack,
    completedOnFormat: { type: "date" },
  };
  const left = standardStatusesLeft(
    template,
    choices,
    statusMap,
    writeWords,
    writeBack,
  );
  return { patch, next: anyLeft(left) ? "statuses" : "owners" };
}
