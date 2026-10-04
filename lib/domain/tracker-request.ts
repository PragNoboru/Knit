import type { TabInfo, TabStructure } from "@/lib/sheets/types";
import { KNIT_ID_HEADER, KNIT_NOTE_HEADER } from "@/lib/sheets/types";
import { formatDay, istDateTime, type LocalDate } from "@/lib/time";

import type { WorkingCalendar } from "./calendar";
import { normaliseKey, USER_STATUSES, type TrackerConfig } from "./config";
import { parseTemplateLink, TEMPLATE_LINK_COPY } from "./guide";
import type { AliasMap } from "./owners";
import { isEmptyRow, normaliseRow, type SheetRow } from "./rows";
import {
  matchStandardTemplate,
  STANDARD_TEMPLATES,
  standardSetupDraft,
  standardStatusesLeft,
  type StandardMatch,
  type StandardStatusesLeft,
  type StandardTemplate,
} from "./standard-template";
import {
  finalConfig,
  statusChoices,
  wizardStructure,
  writeBackOptions,
  type StatusChoice,
} from "./wizard";

/**
 * PRD N83 to N87, 12.9: a person sends the admin a sheet made from the template. These are the
 * checks Knit makes on the sheet before it sends the request, read exactly as the standard
 * setup (11.1, N68, N69) and the pull (10.2) would read it, and every sentence the person
 * sees. Pure: the server action reads Google and the database and passes what it read here.
 *
 * Privacy (N85): no sentence holds a date, title, name or status word read from the sheet. It
 * holds only counts, row numbers, Task IDs used more than once (capped at 40 characters), the
 * sheet's name as Drive lists it once the request is sent, and the template's own words.
 */

// ---------------------------------------------------------------------------------------
// The link and the tab

/** N84: the file id of a link N80 takes (with or without /u/{n}/), or null. */
export function sheetFileId(input: string): string | null {
  return parseTemplateLink(input)?.fileId ?? null;
}

/** N84: the tab whose title is Tasks (normalised: " tasks ", "TASKS"), or null. */
export function findTasksTab<T extends Pick<TabInfo, "title">>(
  tabs: readonly T[],
): T | null {
  return tabs.find((tab) => normaliseKey(tab.title) === "tasks") ?? null;
}

/** N84: row 1 holds Knit's own columns, so the sheet was copied from a tracker. */
export function knitColumnsPresent(
  structure: Pick<TabStructure, "headers">,
): boolean {
  const own = new Set([
    normaliseKey(KNIT_ID_HEADER),
    normaliseKey(KNIT_NOTE_HEADER),
  ]);
  return structure.headers.some((h) => own.has(h.normalised));
}

// ---------------------------------------------------------------------------------------
// The dry run of Use the standard setup (N84)

export interface RequestCheckInput {
  /** Row 1 of the Tasks tab as SheetSource.readStructure gives it, Knit's columns included. */
  rawStructure: TabStructure;
  /** The rows under row 1, as SheetSource.readRows gives them. */
  rows: readonly SheetRow[];
  today: LocalDate;
  calendar: WorkingCalendar;
  aliases: AliasMap;
}

export type FindingKind =
  | "no_tasks"
  | "bad_dates"
  | "no_task_id"
  | "duplicate_task_ids"
  | "status_words"
  | "status_list";

export interface Finding {
  kind: FindingKind;
  /** Sheet row numbers, in order. */
  rows: number[];
  /** duplicate_task_ids: each Task ID as the first of its rows writes it, with its rows. */
  ids?: { id: string; rows: number[] }[];
}

/** Refusals a sheet gets before its rows are read: one sentence each. */
export type StructureRefusal = "knit_columns" | "not_template" | "formula";

export type RequestCheck =
  | {
      kind: "ready";
      template: StandardTemplate;
      taskCount: number;
      /** Rows naming people Knit does not know: they do not block (N84). */
      unknownNameRows: number[];
    }
  | { kind: "refused"; refusal: StructureRefusal; header?: string }
  | { kind: "findings"; findings: Finding[] };

/**
 * N84: the draft Use the standard setup would save, fed exactly as applyStandardSetup feeds it
 * (the Status column's dropdown and the words in it), and the config the dry run reads the rows
 * with: that draft, with every write-back the setup could not fill left out (null), since only
 * reading is tried.
 */
export function requestDryRun(
  match: Extract<StandardMatch, { problem: null }>,
  structure: TabStructure,
  rows: readonly SheetRow[],
): {
  config: TrackerConfig;
  choices: StatusChoice[];
  left: StandardStatusesLeft;
} {
  const status = match.headers[normaliseKey("Status")] ?? "Status";
  const dropdown = structure.validations[normaliseKey(status)]?.options ?? null;
  const choices = statusChoices(rows, status, dropdown);
  const writeWords = writeBackOptions(rows, status, dropdown);
  const { patch } = standardSetupDraft(match, structure, choices, writeWords);
  const left = standardStatusesLeft(
    match.template,
    choices,
    patch.statusMap,
    writeWords,
    patch.writeBack,
  );
  const writeBack = Object.fromEntries(
    USER_STATUSES.map((s) => [s, patch.writeBack?.[s] ?? null]),
  ) as TrackerConfig["writeBack"];
  const config = finalConfig({ ...patch, writeBack });
  // The preset always fills a complete config; a failure here is a bug, not the sheet's.
  if (!config.success) throw new Error("standard setup config is incomplete");
  return { config: config.data, choices, left };
}

/**
 * N84: the checks of a sheet's Tasks tab, after the folder, the file type and the tab: Knit's
 * own columns, the template's row 1 and its write columns, then a dry run of the standard
 * setup over the rows as the pull reads them.
 */
export function checkTrackerRequest(input: RequestCheckInput): RequestCheck {
  if (knitColumnsPresent(input.rawStructure))
    return { kind: "refused", refusal: "knit_columns" };
  const structure = wizardStructure(input.rawStructure);
  const match = matchStandardTemplate(structure);
  if (!match) return { kind: "refused", refusal: "not_template" };
  if (match.problem !== null) {
    // The template's own spelling of the write column that holds formulas.
    const header = match.template.writeTargets.find((target) =>
      structure.formulaColumns.includes(normaliseKey(target)),
    );
    return { kind: "refused", refusal: "formula", header: header ?? "Status" };
  }

  const { config, choices, left } = requestDryRun(match, structure, input.rows);
  const tasks = input.rows
    .filter((row) => !isEmptyRow(row, config))
    .map((row) =>
      normaliseRow(row, {
        config,
        calendar: input.calendar,
        aliases: input.aliases,
        trackerOwnerId: null,
        today: input.today,
        knitIdHeader: KNIT_ID_HEADER,
      }),
    );
  if (tasks.length === 0)
    return { kind: "findings", findings: [{ kind: "no_tasks", rows: [] }] };

  const findings: Finding[] = [];
  const add = (kind: FindingKind, rows: number[]) => {
    if (rows.length > 0) findings.push({ kind, rows });
  };
  add(
    "bad_dates",
    tasks
      .filter(
        (t) =>
          t.date.kind === "invalid" ||
          t.date.kind === "empty" ||
          t.outsideCalendar,
      )
      .map((t) => t.rowNumber),
  );
  add(
    "no_task_id",
    tasks.filter((t) => t.sourceRef === null).map((t) => t.rowNumber),
  );
  const byId = new Map<string, { id: string; rows: number[] }>();
  for (const task of tasks) {
    if (task.sourceRef === null) continue;
    const key = normaliseKey(task.sourceRef);
    const group = byId.get(key) ?? { id: task.sourceRef.trim(), rows: [] };
    group.rows.push(task.rowNumber);
    byId.set(key, group);
  }
  const duplicates = [...byId.values()].filter((g) => g.rows.length > 1);
  if (duplicates.length > 0)
    findings.push({
      kind: "duplicate_task_ids",
      rows: duplicates.flatMap((g) => g.rows).sort((a, b) => a - b),
      ids: duplicates,
    });
  add(
    "status_words",
    tasks.filter((t) => !t.status.mapped).map((t) => t.rowNumber),
  );
  // The setup would open Map statuses for a word only the Status list offers, or for one of
  // the five words the list lacks (11.1, N69). Words in the rows are status_words above.
  const listOnly = choices.some(
    (c) =>
      c.count === 0 && c.inDropdown && config.statusMap[c.key] === undefined,
  );
  if (listOnly || left.notOffered.length > 0)
    findings.push({ kind: "status_list", rows: [] });

  if (findings.length > 0) return { kind: "findings", findings };
  return {
    kind: "ready",
    template: match.template,
    taskCount: tasks.length,
    unknownNameRows: tasks
      .filter((t) => t.unknownOwners.length > 0)
      .map((t) => t.rowNumber),
  };
}

// ---------------------------------------------------------------------------------------
// What the person sees (N85, 12.9)

/** N85: at most this many rows or Task IDs in a finding, then "and {n} more". */
export const LIST_LIMIT = 10;
/** N85: a Task ID is shown with at most this many characters. */
export const TASK_ID_LIMIT = 40;
/** N87: the note's length. */
export const NOTE_MAX_LENGTH = 280;

/** {first ten}, and {n} more. */
export function listOf(items: readonly string[]): string {
  const shown = items.slice(0, LIST_LIMIT).join(", ");
  const more = items.length - LIST_LIMIT;
  return more > 0 ? `${shown}, and ${more} more` : shown;
}

/** "row 7" or "rows 3, 5" (N85). */
export function rowsText(rows: readonly number[]): string {
  return rows.length === 1
    ? `row ${rows[0]}`
    : `rows ${listOf(rows.map(String))}`;
}

/** N85: a Task ID trimmed and cut to 40 characters, so a cell cannot carry task content. */
export function capTaskId(id: string): string {
  const text = id.replace(/\s+/g, " ").trim();
  return text.length > TASK_ID_LIMIT
    ? `${text.slice(0, TASK_ID_LIMIT - 1)}…`
    : text;
}

/** The template's five Status words, as the sheet spells them (N81). */
export const statusWordsOf = (template: StandardTemplate) =>
  USER_STATUSES.map((s) => template.statusWords[s]).join(", ");

const NEWEST = STANDARD_TEMPLATES[0]!;

/** A template version's name from its id, or the id when no version has it. */
export function templateName(templateId: string): string {
  return (
    STANDARD_TEMPLATES.find((t) => t.id === templateId)?.name ?? templateId
  );
}

export const REQUEST_COPY = {
  heading: "Send a sheet to the admin",
  linkLabel: "Link to your sheet",
  linkHint:
    "The Google Sheets link of your filled copy, once it is in the Knit folder.",
  noteLabel: "Note for the admin (optional)",
  noteHint: "For example the brand, and who works on it. Up to 280 characters.",
  submit: "Check and send",
  pending: "Checking the sheet",
  folderStep:
    "Get the sheet into the Knit folder: move it there yourself if you can edit that folder (into the folder itself, not a folder inside it, and not as a shortcut), or share it with the admin and ask them to move it.",
  sendStep:
    "Then paste its link below and press Check and send. Knit checks the sheet and, when it can be connected, tells the admin, who connects it. Its tasks then reach the Today of the people named in it.",
  sent: "Sent to the admin.",
  findingsIntro:
    "Knit cannot send this sheet yet. Fix these in the sheet, then press Check and send again:",
  yourRequests: "Your requests",
  waiting: "Waiting for the admin",
  connected: "Connected",
  passwords:
    "The admin makes every login and sets every password. To change yours, ask the admin.",
} as const;

/** Why a request was not sent, said in one sentence (12.9). */
export type RequestRefusal =
  | "invalid_link"
  | "note_too_long"
  | "blank_template"
  | "already_tracker"
  | "setting_up"
  | "archived"
  | "already_requested"
  | "limit"
  | "not_in_folder"
  | "not_a_sheet"
  | "no_tasks_tab"
  | StructureRefusal
  | "read_failed"
  | "failed";

const REFUSALS: Record<Exclude<RequestRefusal, "formula">, string> = {
  invalid_link: TEMPLATE_LINK_COPY.invalid,
  note_too_long: "Keep the note to 280 characters.",
  blank_template:
    "This is the blank template. Make your own copy with Get the tracker template, fill it in and send the copy's link.",
  already_tracker: "This sheet is already a tracker in Knit.",
  setting_up: "The admin is already setting up this sheet.",
  archived:
    "This sheet was set up in Knit before and then archived. Make a new copy of the template, fill it in and send that.",
  already_requested: "This sheet has already been sent to the admin.",
  limit:
    "You have checked 5 sheets in the last 10 minutes. Try again in a few minutes.",
  not_in_folder:
    "Knit cannot find this sheet in the Knit folder. Move it into the Knit folder itself, not a folder inside it or a shortcut, or share it with the admin and ask them to move it. Then send the link again.",
  not_a_sheet:
    "This file is not a Google Sheet. Open it and use File > Save as Google Sheets, get the new sheet into the Knit folder and send its link.",
  no_tasks_tab:
    "This sheet has no Tasks tab. Keep the template's Tasks tab and its name.",
  knit_columns:
    "This sheet already has Knit's own columns, so it was copied from a tracker. Start again from a new copy of the template.",
  not_template:
    "Row 1 of the Tasks tab is not the template's. Keep row 1 exactly as the template has it.",
  read_failed: "Knit could not read the sheet just now. Try again in a minute.",
  failed: "The request could not be sent. Try again.",
};

/** The sentence for a refusal. `header` is the template's own write column (formula). */
export function refusalText(refusal: RequestRefusal, header?: string): string {
  if (refusal === "formula")
    return `"${header ?? "Status"}" holds formulas, so Knit could not write to it. Keep it as plain cells, as in the template.`;
  return REFUSALS[refusal];
}

/** One line per finding, in the order of N84; status words name the newest template's five. */
export function findingLines(
  findings: readonly Finding[],
  template: StandardTemplate = NEWEST,
): string[] {
  const words = statusWordsOf(template);
  return findings.map((finding) => {
    switch (finding.kind) {
      case "no_tasks":
        return "The Tasks tab has no tasks yet.";
      case "bad_dates":
        return `Dates Knit cannot read or use: ${rowsText(finding.rows)}.`;
      case "no_task_id":
        return `No Task ID: ${rowsText(finding.rows)}.`;
      case "duplicate_task_ids": {
        const groups = (finding.ids ?? []).map(
          (g) => `${capTaskId(g.id)} (${rowsText(g.rows)})`,
        );
        const shown = groups.slice(0, LIST_LIMIT).join("; ");
        const more = groups.length - LIST_LIMIT;
        return `Task IDs used more than once: ${more > 0 ? `${shown}, and ${more} more` : shown}.`;
      }
      case "status_words":
        return `A Status that is not one of the five words (${words}): ${rowsText(finding.rows)}.`;
      case "status_list":
        return `The Status list was changed. Keep the template's five words: ${words}.`;
    }
  });
}

/** N85: what a sent request says under "Sent to the admin.". */
export function sentLines(sent: {
  fileName: string;
  taskCount: number;
  template: StandardTemplate;
  unknownNameRows: readonly number[];
}): string[] {
  const tasks = sent.taskCount === 1 ? "1 task" : `${sent.taskCount} tasks`;
  const lines = [
    `${sent.fileName}: ${tasks}, in the ${sent.template.name} layout.`,
  ];
  const rows = sent.unknownNameRows;
  if (rows.length === 1)
    lines.push(
      `Row ${rows[0]} names someone Knit does not know yet. The admin links them when connecting the sheet.`,
    );
  else if (rows.length > 1)
    lines.push(
      `Rows ${listOf(rows.map(String))} name people Knit does not know yet. The admin links them when connecting the sheet.`,
    );
  return lines;
}

// ---------------------------------------------------------------------------------------
// Your requests (N85)

export type RequestState = "open" | "connected" | "dismissed";

/** One of the person's own requests, as the Guide lists it. */
export interface MyTrackerRequest {
  id: number;
  fileName: string;
  state: RequestState;
  dismissReason: string | null;
  createdAt: string;
}

/** The day a request was sent, in IST: "Mon 5 Oct" (invariant 1). */
export function sentDay(createdAt: string): string {
  return formatDay(istDateTime(createdAt).date);
}

export function requestStateText(
  state: RequestState,
  reason: string | null,
): string {
  if (state === "open") return REQUEST_COPY.waiting;
  if (state === "connected") return REQUEST_COPY.connected;
  return `Not taken: ${reason ?? ""}`.trim();
}

/** N86, 11 step 1: under a sheet in New sheet found that has an open request. */
export const requestedByText = (name: string) => `Requested by ${name}`;

/** "{sheet} · sent {EEE d MMM}". */
export const requestLine = (fileName: string, createdAt: string) =>
  `${fileName} · sent ${sentDay(createdAt)}`;
