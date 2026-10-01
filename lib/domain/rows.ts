import { fromSheetsSerial, type LocalDate } from "@/lib/time";

import { CalendarNotCoveredError, type WorkingCalendar } from "./calendar";
import { normaliseKey, type TrackerConfig, type UserStatus } from "./config";
import {
  isBlankCell,
  normaliseDateText,
  parseDateText,
  parsePlannedRange,
  textOf,
  type CellValue,
  type ParsedDate,
} from "./dates";
import { dueDateFor, plannedDueSource } from "./due-date";
import { assigneesFor, type AliasMap } from "./owners";
import { mapSourceStatus, type SourceStatus } from "./status";
import { renderTemplate, templateHeaders } from "./templates";

/**
 * PRD 10.2 step 5: a sheet row turned into what the planner needs. Pure; `today` is a
 * parameter.
 */

/** A data row as SheetSource.readRows returns it: cells keyed by normalised header. */
export interface SheetRow {
  rowNumber: number;
  cells: Record<string, CellValue>;
}

/** What Knit last read from, or wrote to, the status and completed-on columns (10.3). */
export interface SourceSnapshot {
  statusKey: string;
  completedOn: LocalDate | null;
  /**
   * The Knit status the word stood for when Knit read or wrote it, or null when the word was
   * unmapped then (6.8: its row counted as Yet to Start). N28: while a row shows the same
   * word, the pull reads it as this recorded status, so remapping a word (N19 d, 11) changes
   * no existing task: the new mapping reaches new rows and rows whose word changes later. A
   * word recorded null and mapped since is a change made in the source (N60). Absent from
   * snapshots saved before it was recorded: those use the current status map. A push that
   * writes the status cell records it with the word (10.4 step 5).
   */
  status?: UserStatus | null;
}

export interface NormalisedRow {
  knitId: string;
  rowNumber: number;
  title: string;
  subtitle: string | null;
  details: Record<string, string>;
  sourceRef: string | null;
  critical: boolean;
  ownerRaw: string | null;
  assignees: string[];
  unknownOwners: string[];
  plannedRaw: string;
  date: ParsedDate;
  /** Null for open-ended, invalid or empty dates, and when the calendar does not cover it. */
  dueDate: LocalDate | null;
  /** The planned date fell on an off day and the due date moved (6.3.3). */
  offDayMove: boolean;
  /** The due date could not be computed because the calendar does not cover the date. */
  outsideCalendar: boolean;
  statusRaw: string;
  status: SourceStatus;
  completedOn: LocalDate | null;
  snapshot: SourceSnapshot;
}

export interface RowContext {
  config: TrackerConfig;
  calendar: WorkingCalendar;
  aliases: AliasMap;
  trackerOwnerId: string | null;
  today: LocalDate;
  knitIdHeader: string;
}

const EMPTY: CellValue = { value: null, formatted: "" };

export function cellOf(row: SheetRow, header: string): CellValue {
  return row.cells[normaliseKey(header)] ?? EMPTY;
}

export { isBlankCell, textOf };

/** Headers that decide whether a row has any content (10.2 step 3). */
export function contentHeaders(config: TrackerConfig): string[] {
  const { columns } = config;
  return [
    columns.date,
    // N64: a row holding only an End date is not empty, so it raises bad_date (N65).
    ...(columns.endDate ? [columns.endDate] : []),
    columns.title,
    columns.statusRead,
    ...(columns.owner ? [columns.owner] : []),
    ...(columns.sourceRef ? [columns.sourceRef] : []),
    ...templateHeaders(config.titleTemplate),
  ];
}

/** 10.2 step 3: rows empty in every mapped column are ignored. */
export function isEmptyRow(row: SheetRow, config: TrackerConfig): boolean {
  return contentHeaders(config).every((header) =>
    isBlankCell(cellOf(row, header)),
  );
}

/**
 * N66: the planned date as the sheet shows it. The Date cell's text, or "{Date} to {End date}"
 * when an End date is mapped and filled ("to {End date}" when the Date is blank). The pull
 * stores it as planned_raw and the Knit ID recreate (N19 e) matches by it.
 */
export function plannedRawOf(
  row: SheetRow,
  config: { columns: Pick<TrackerConfig["columns"], "date" | "endDate"> },
): string {
  const date = textOf(cellOf(row, config.columns.date));
  const endHeader = config.columns.endDate;
  const endCell = endHeader ? cellOf(row, endHeader) : null;
  return endCell === null || isBlankCell(endCell)
    ? date
    : `${date} to ${textOf(endCell)}`.trim();
}

function parseCompletedOn(cell: CellValue, today: LocalDate): LocalDate | null {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return fromSheetsSerial(cell.value);
  }
  const parsed = parseDateText(normaliseDateText(textOf(cell)), today);
  return parsed.kind === "single" ? parsed.start : null;
}

export function normaliseRow(row: SheetRow, ctx: RowContext): NormalisedRow {
  const { config, calendar, aliases, today } = ctx;
  const { columns } = config;
  const text = (header: string) => textOf(cellOf(row, header));
  const lookup = (normalisedHeader: string) =>
    textOf(row.cells[normalisedHeader] ?? EMPTY);

  const date = parsePlannedRange(
    cellOf(row, columns.date),
    columns.endDate ? cellOf(row, columns.endDate) : null,
    today,
  );
  let dueDate: LocalDate | null = null;
  let outsideCalendar = false;
  try {
    dueDate = dueDateFor(date, config.offDayPolicy, calendar);
  } catch (error) {
    if (!(error instanceof CalendarNotCoveredError)) throw error;
    outsideCalendar = true;
  }
  const planned = plannedDueSource(date);

  const owners = assigneesFor(
    columns.owner ? text(columns.owner) : null,
    config,
    aliases,
    ctx.trackerOwnerId,
  );

  const statusRaw = text(columns.statusRead);
  const status = mapSourceStatus(statusRaw, config);
  const completedOn = columns.completedOn
    ? parseCompletedOn(cellOf(row, columns.completedOn), today)
    : null;

  const details: Record<string, string> = {};
  for (const header of config.detailColumns) {
    const value = text(header);
    if (value !== "") details[header] = value;
  }

  const truthy = new Set((columns.critical?.truthy ?? []).map(normaliseKey));
  const subtitle = config.subtitleTemplate
    ? renderTemplate(config.subtitleTemplate, lookup)
    : "";

  return {
    knitId: text(ctx.knitIdHeader),
    rowNumber: row.rowNumber,
    title: renderTemplate(config.titleTemplate, lookup) || text(columns.title),
    subtitle: subtitle === "" ? null : subtitle,
    details,
    sourceRef: columns.sourceRef ? text(columns.sourceRef) || null : null,
    critical: columns.critical
      ? truthy.has(normaliseKey(text(columns.critical.header)))
      : false,
    ownerRaw: columns.owner ? text(columns.owner) || null : null,
    assignees: owners.userIds,
    unknownOwners: owners.unknown,
    plannedRaw: plannedRawOf(row, config),
    date,
    dueDate,
    offDayMove: dueDate !== null && planned !== null && dueDate !== planned,
    outsideCalendar,
    statusRaw,
    status,
    completedOn,
    snapshot: {
      statusKey: status.key,
      status: status.mapped ? status.status : null,
      completedOn,
    },
  };
}
