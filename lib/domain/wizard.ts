import { z } from "zod";

import type { LocalDate } from "@/lib/time";

import { TRACKER_COLORS, type TrackerColor } from "./cards";
import {
  KnitUserStatus,
  normaliseKey,
  TrackerConfig,
  USER_STATUSES,
  type UserStatus,
} from "./config";
import { parsePlannedDate, type CellValue } from "./dates";
import { cellOf, textOf, type NormalisedRow, type SheetRow } from "./rows";

/**
 * PRD 11: the tracker setup wizard's rules. The wizard keeps a draft config (a tracker in
 * state `draft`) and fills it step by step; nothing is written to the sheet before step 9.
 */

/** 11: the draft, saved after each step. Everything is optional until activation. */
export const DraftConfig = z.object({
  headerRow: z.number().int().min(1).optional(),
  columns: TrackerConfig.shape.columns.partial().optional(),
  readOnlyColumns: z.array(z.string()).optional(),
  titleTemplate: z.string().optional(),
  subtitleTemplate: z.string().nullable().optional(),
  detailColumns: z.array(z.string()).max(8).optional(),
  ownerSeparators: z.array(z.string().min(1)).optional(),
  ownerFilter: z.enum(["mine", "all"]).optional(),
  offDayPolicy: z
    .enum(["previous_working_day", "next_working_day", "keep"])
    .optional(),
  statusMap: z.record(z.string(), KnitUserStatus).optional(),
  cancelReasons: z.record(z.string(), z.string()).optional(),
  writeBack: TrackerConfig.shape.writeBack.partial().optional(),
  completedOnFormat: TrackerConfig.shape.completedOnFormat.optional(),
});
export type DraftConfig = z.infer<typeof DraftConfig>;

export type WizardStep =
  | "tab"
  | "header"
  | "columns"
  | "statuses"
  | "owners"
  | "details"
  | "preview"
  | "activate";

/** 11 steps 2 to 9, in order. Step 1 is the New sheet found list; step 10 the backlog. */
export const WIZARD_STEPS: readonly { step: WizardStep; title: string }[] = [
  { step: "tab", title: "Pick tab" },
  { step: "header", title: "Header row" },
  { step: "columns", title: "Map columns" },
  { step: "statuses", title: "Map statuses" },
  { step: "owners", title: "Owners and policies" },
  { step: "details", title: "Name, colour, go-live" },
  { step: "preview", title: "Preview" },
  { step: "activate", title: "Activate" },
];

const looksLikeDate = (text: string, today: LocalDate) => {
  const parsed = parsePlannedDate({ value: text, formatted: text }, today);
  return parsed.kind !== "invalid" && parsed.kind !== "empty";
};

/**
 * 11 step 3: the first mostly-text row of the first ten: at least two cells, and most of them
 * words rather than numbers or dates. 1-based; 1 when nothing qualifies.
 */
export function suggestHeaderRow(
  rows: readonly (readonly string[])[],
  today: LocalDate,
): number {
  for (const [index, row] of rows.slice(0, 10).entries()) {
    const cells = row.map((cell) => cell.trim()).filter((cell) => cell !== "");
    if (cells.length < 2) continue;
    const words = cells.filter(
      (cell) => /\p{L}/u.test(cell) && !looksLikeDate(cell, today),
    );
    if (words.length / cells.length > 0.5) return index + 1;
  }
  return 1;
}

/** 11 step 4: up to five sample values of a column, from the first rows that have one. */
export function columnSamples(
  rows: readonly SheetRow[],
  header: string,
  count = 5,
): string[] {
  const samples: string[] = [];
  for (const row of rows) {
    const text = textOf(cellOf(row, header));
    if (text !== "") samples.push(text);
    if (samples.length === count) break;
  }
  return samples;
}

export interface DateParseRate {
  parsed: number;
  total: number;
  /** Share of non-empty date cells Knit can read, 0 to 1 (1 when there are none). */
  rate: number;
  /** Up to ten distinct values it cannot read. */
  failing: string[];
}

/** 11 step 4: how many of the date column's non-empty cells parse; under 90% warns. */
export function dateParseRate(
  rows: readonly SheetRow[],
  dateHeader: string,
  today: LocalDate,
): DateParseRate {
  let parsed = 0;
  let total = 0;
  const failing = new Set<string>();
  for (const row of rows) {
    const cell: CellValue = cellOf(row, dateHeader);
    const result = parsePlannedDate(cell, today);
    if (result.kind === "empty") continue;
    total += 1;
    if (result.kind === "invalid") {
      if (failing.size < 10) failing.add(textOf(cell));
    } else parsed += 1;
  }
  return {
    parsed,
    total,
    rate: total === 0 ? 1 : parsed / total,
    failing: [...failing],
  };
}

export const DATE_RATE_WARNING = 0.9;

export interface StatusChoice {
  /** Normalised word, the statusMap key ("" for a blank cell). */
  key: string;
  /** The word as the sheet shows it. */
  word: string;
  /** Rows holding it now. */
  count: number;
  /** In the column's dropdown rule. */
  inDropdown: boolean;
}

/**
 * 11 step 5, 6.8: every value of the status column's dropdown plus every distinct value found
 * (a blank cell included), each with its count.
 */
export function statusChoices(
  rows: readonly SheetRow[],
  statusHeader: string,
  dropdown: readonly string[] | null,
): StatusChoice[] {
  const choices = new Map<string, StatusChoice>();
  const add = (word: string, count: number, inDropdown: boolean) => {
    const key = normaliseKey(word);
    const found = choices.get(key);
    if (found) {
      found.count += count;
      found.inDropdown ||= inDropdown;
    } else choices.set(key, { key, word: word.trim(), count, inDropdown });
  };
  for (const option of dropdown ?? []) add(option, 0, true);
  for (const row of rows) add(textOf(cellOf(row, statusHeader)), 1, false);
  return [...choices.values()].sort(
    (a, b) =>
      Number(b.inDropdown) - Number(a.inDropdown) ||
      b.count - a.count ||
      a.key.localeCompare(b.key, "en"),
  );
}

/** 11 step 5: the words a write-back can use: the dropdown's options, else the words found. */
export function writeBackWords(choices: readonly StatusChoice[]): string[] {
  const inDropdown = choices.filter((c) => c.inDropdown && c.word !== "");
  const source = inDropdown.length > 0 ? inDropdown : choices;
  return source.map((c) => c.word).filter((word) => word !== "");
}

/** 11 step 5: activation is blocked while any value is unmapped. */
export function unmappedChoices(
  choices: readonly StatusChoice[],
  statusMap: Readonly<Record<string, UserStatus>> | undefined,
): StatusChoice[] {
  return choices.filter((choice) => statusMap?.[choice.key] === undefined);
}

/** What still blocks activation, step by step (11). Empty when the draft is complete. */
export function draftProblems(draft: DraftConfig): {
  step: WizardStep;
  problem: string;
}[] {
  const problems: { step: WizardStep; problem: string }[] = [];
  if (draft.headerRow === undefined)
    problems.push({ step: "header", problem: "Choose the header row." });
  const columns = draft.columns ?? {};
  if (!columns.date)
    problems.push({ step: "columns", problem: "Choose the date column." });
  if (!columns.title)
    problems.push({ step: "columns", problem: "Choose the title column." });
  if (!columns.statusRead)
    problems.push({ step: "columns", problem: "Choose the status column." });
  if (draft.statusMap === undefined)
    problems.push({ step: "statuses", problem: "Map the statuses." });
  if (
    draft.writeBack === undefined ||
    USER_STATUSES.some((status) => draft.writeBack?.[status] === undefined)
  )
    problems.push({
      step: "statuses",
      problem: "Choose a write-back value for every Knit status.",
    });
  if (problems.length === 0 && !finalConfig(draft).success)
    problems.push({ step: "columns", problem: "Check the column choices." });
  return problems;
}

/** The complete registry (8.2) from a finished draft. */
export function finalConfig(draft: DraftConfig) {
  const columns = draft.columns ?? {};
  return TrackerConfig.safeParse({
    headerRow: draft.headerRow,
    columns: {
      date: columns.date,
      title: columns.title,
      statusRead: columns.statusRead,
      statusWrite: columns.statusWrite ?? null,
      completedOn: columns.completedOn ?? null,
      owner: columns.owner ?? null,
      sourceRef: columns.sourceRef ?? null,
      critical: columns.critical ?? null,
    },
    readOnlyColumns: draft.readOnlyColumns ?? [],
    titleTemplate: draft.titleTemplate || `{${columns.title ?? ""}}`,
    subtitleTemplate: draft.subtitleTemplate ?? null,
    detailColumns: draft.detailColumns ?? [],
    ownerSeparators: draft.ownerSeparators ?? [","],
    ownerFilter: draft.ownerFilter ?? "mine",
    offDayPolicy: draft.offDayPolicy ?? "previous_working_day",
    statusMap: draft.statusMap ?? {},
    cancelReasons: draft.cancelReasons ?? {},
    writeBack: draft.writeBack,
    completedOnFormat: draft.completedOnFormat ?? null,
  });
}

export interface PreviewStats {
  tasks: number;
  mine: number;
  byKind: Record<"single" | "window" | "open", number>;
  offDayMoves: number;
  invalidDates: number;
  unmappedStatuses: string[];
  historyOnly: number;
}

/** 11 step 8: the counts shown before anything is written. */
export function previewStats(
  rows: readonly NormalisedRow[],
  goLive: LocalDate,
): PreviewStats {
  const stats: PreviewStats = {
    tasks: 0,
    mine: 0,
    byKind: { single: 0, window: 0, open: 0 },
    offDayMoves: 0,
    invalidDates: 0,
    unmappedStatuses: [],
    historyOnly: 0,
  };
  const unmapped = new Set<string>();
  for (const row of rows) {
    if (!row.status.mapped) unmapped.add(row.statusRaw || "(blank)");
    const kind = row.date.kind;
    if (kind === "invalid" || kind === "empty") {
      stats.invalidDates += 1;
      continue;
    }
    stats.tasks += 1;
    stats.byKind[kind] += 1;
    if (row.assignees.length > 0) stats.mine += 1;
    if (row.offDayMove) stats.offDayMoves += 1;
    if (row.dueDate !== null && row.dueDate < goLive) stats.historyOnly += 1;
  }
  stats.unmappedStatuses = [...unmapped].sort();
  return stats;
}

/** 11 step 6: owner names in the tab that are neither users nor known non-users. */
export function unknownOwnerNames(rows: readonly NormalisedRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.unknownOwners))].sort();
}

/** 11 step 7: the first colour of the palette no other tracker uses. */
export function nextColour(used: readonly string[]): TrackerColor {
  return TRACKER_COLORS.find((c) => !used.includes(c)) ?? TRACKER_COLORS[0];
}

/** Reads a status word's normalised key back from a form field name. */
export const statusField = (key: string) => `status:${key}`;
export const writeBackField = (status: UserStatus) => `writeBack:${status}`;

/** Form values for "leave the cell unchanged" (N8) and "clear the cell" (6.8). */
export const LEAVE_UNCHANGED = "__leave__";
export const CLEAR_CELL = "__clear__";
