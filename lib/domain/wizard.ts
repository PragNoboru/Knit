import { z } from "zod";

import { KNIT_ID_HEADER, KNIT_NOTE_HEADER } from "@/lib/sheets/types";
import {
  addDays,
  formatDate,
  makeDate,
  monthOf,
  yearOf,
  type LocalDate,
} from "@/lib/time";

import { CalendarNotCoveredError, type WorkingCalendar } from "./calendar";
import { TRACKER_COLORS, type TrackerColor } from "./cards";
import {
  KnitUserStatus,
  normaliseKey,
  TrackerConfig,
  USER_STATUSES,
  type UserStatus,
} from "./config";
import {
  normaliseDateText,
  parseDateText,
  parsePlannedDate,
  type CellValue,
} from "./dates";
import { cellOf, textOf, type NormalisedRow, type SheetRow } from "./rows";
import { templateHeaders } from "./templates";

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
  /** 11 step 7: the admin saved a go-live date; until then it defaults to the next working day (N42). */
  goLiveChosen: z.boolean().optional(),
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

/**
 * 11 step 5, 6.8: the words Knit may write back. writeBack is "the exact word written to the
 * statusWrite column", so they come from that column: its dropdown's options, else the words
 * found in it. None when no write column is mapped (N8: the sheet's statuses are left alone).
 */
export function writeBackOptions(
  rows: readonly SheetRow[],
  statusWrite: string | null | undefined,
  dropdown: readonly string[] | null,
): string[] {
  return statusWrite
    ? writeBackWords(statusChoices(rows, statusWrite, dropdown))
    : [];
}

/** 11 step 5: a write-back value the form sent, checked against what the step offered. */
export function writeBackValue(
  posted: string,
  words: readonly string[],
  canWrite: boolean,
): { ok: true; value: string | null } | { ok: false } {
  if (posted === LEAVE_UNCHANGED) return { ok: true, value: null };
  if (!canWrite) return { ok: false };
  if (posted === CLEAR_CELL) return { ok: true, value: "" };
  return words.includes(posted) ? { ok: true, value: posted } : { ok: false };
}

type ColumnChoices = NonNullable<DraftConfig["columns"]>;

/**
 * Invariant 5, 6.8, 11 step 4: Knit writes only the status cell and the completed-on cell (and
 * its own two columns), so neither write target may be a column that holds the task's content:
 * the planned date, the title (or a header in the title template), the owner, the source ID or
 * the critical flag. The two targets are different columns, and the completed-on date never goes
 * into the column Knit reads the status from. Status (write) may be Status (read). A plain
 * sentence for the first problem, or null.
 */
export function writeTargetProblem(
  columns: ColumnChoices,
  titleTemplate: string | null | undefined,
): string | null {
  const roles: [string | null | undefined, string][] = [
    [columns.date, "the planned date"],
    [columns.title, "the title"],
    ...(titleTemplate ? templateHeaders(titleTemplate) : []).map(
      (header): [string, string] => [header, "part of the title"],
    ),
    [columns.owner, "the owner"],
    [columns.sourceRef, "the source ID"],
    [columns.critical?.header, "the critical flag"],
    [KNIT_ID_HEADER, "Knit's own ID column"],
    [KNIT_NOTE_HEADER, "Knit's own note column"],
  ];
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    Boolean(a) && Boolean(b) && normaliseKey(a!) === normaliseKey(b!);
  for (const target of [columns.statusWrite, columns.completedOn]) {
    if (!target) continue;
    const role = roles.find(([header]) => same(header, target));
    if (role)
      return `"${target}" is ${role[1]}, which Knit never changes. Choose another column to write to.`;
  }
  if (same(columns.statusWrite, columns.completedOn))
    return "Status (write) and Completed on must be different columns.";
  if (same(columns.completedOn, columns.statusRead))
    return "Completed on cannot be the column Knit reads the status from.";
  return null;
}

// formatDate's tokens (lib/time), longest first, and text in single quotes.
const PATTERN_PARTS = /'[^']*'|EEEE|EEE|dd|d|MMMM|MMM|MM|M|yyyy|yy/g;

/**
 * 6.8 completedOnFormat {type: "text", pattern}: Knit writes the completion date in this
 * pattern and reads it back when it verifies the write and when it clears the cell on a revert
 * (10.4). So every letter must be one of formatDate's tokens (EEEE, EEE, d, dd, MMMM, MMM, M,
 * MM, yyyy, yy) or quoted text, the pattern needs a day and a month, and dates written in it
 * must read back as the same date (checked on dates near today, day numbers above and below
 * 12). "dd/mm/yyyy" would write "28/mm/2026". A plain sentence, or null.
 */
export function completedOnPatternProblem(
  pattern: string,
  today: LocalDate,
): string | null {
  const refuse = `Knit cannot write dates as "${pattern}" and read them back. Use its letters: d or dd for the day, MMM, MMMM, M or MM for the month, yyyy or yy for the year and EEE for the weekday, for example EEE d MMM or dd/MM/yyyy.`;
  const tokens = pattern.match(PATTERN_PARTS) ?? [];
  if (/\p{L}/u.test(pattern.replace(PATTERN_PARTS, ""))) return refuse;
  if (!tokens.some((t) => t === "d" || t === "dd")) return refuse;
  if (!tokens.some((t) => /^M+$/.test(t))) return refuse;
  const samples = [0, 30].flatMap((offset) => {
    const month = addDays(today, offset);
    return [5, 20]
      .map((day) => makeDate(yearOf(month), monthOf(month), day))
      .filter((date): date is LocalDate => date !== null);
  });
  for (const date of [today, ...samples]) {
    const read = parseDateText(
      normaliseDateText(formatDate(date, pattern)),
      today,
    );
    if (read.kind !== "single" || read.start !== date) return refuse;
  }
  return null;
}

/** What still blocks activation, step by step (11). Empty when the draft is complete. */
export function draftProblems(
  draft: DraftConfig,
  found: {
    /** 11 step 5: words in the status column now (its rows and dropdown) with no Knit status. */
    unmappedWords?: readonly string[];
  } = {},
): {
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
  const conflict = writeTargetProblem(columns, draft.titleTemplate);
  if (conflict) problems.push({ step: "columns", problem: conflict });
  if (draft.statusMap === undefined)
    problems.push({ step: "statuses", problem: "Map the statuses." });
  else if (found.unmappedWords && found.unmappedWords.length > 0)
    problems.push({
      step: "statuses",
      problem: `Choose a Knit status for every word. Not mapped yet: ${found.unmappedWords
        .map((word) => (word === "" ? "(blank)" : word))
        .join(", ")}.`,
    });
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

/** 11 step 7 (N42): said when there is no default go-live and the admin has not saved one. */
export const GO_LIVE_NEEDS_A_DATE =
  "Choose a go-live date at step 7: the working-day calendar does not reach the next working day yet.";

/**
 * 11 step 7 (N42, N19 b): the tracker's go-live is a date already settled, the one saved at
 * step 7 or the date of a tracker no longer a draft, rather than the default worked out now.
 */
export function goLiveSaved(tracker: {
  state: string;
  draft: DraftConfig;
}): boolean {
  return tracker.state !== "draft" || tracker.draft.goLiveChosen === true;
}

/**
 * 11 step 7 (N42, 6.2): until the admin saves a date at step 7, go-live is the first working
 * day after today, worked out from the day the admin is at step 7, the preview or the activate
 * step, or activates, not the day setup started. Null when the calendar does not cover that
 * day: it is never guessed (invariant 7), so the admin must choose a date. A date the admin
 * saved at step 7 stays, whatever it is, and is fixed once the tracker is live (N19 b).
 */
export function goLiveDefault(
  tracker: { state: string; goLiveDate: LocalDate; draft: DraftConfig },
  today: LocalDate,
  calendar: WorkingCalendar,
): LocalDate | null {
  if (goLiveSaved(tracker)) return tracker.goLiveDate;
  try {
    return calendar.nextWorkingDay(today);
  } catch (error) {
    if (error instanceof CalendarNotCoveredError) return null;
    throw error;
  }
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
