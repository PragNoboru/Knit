import {
  diffDays,
  fromSheetsSerial,
  isoWeekday,
  makeDate,
  yearOf,
  type LocalDate,
} from "@/lib/time";

/**
 * PRD 6.3.2: parsePlannedDate turns a tracker's date cell into a planned date. Pure; `today`
 * is a parameter. When unsure it answers `invalid` with a reason, never a guess (invariant 7).
 */

/** A cell as the Sheets API returns it: the unformatted value and the displayed text. */
export interface CellValue {
  value: string | number | boolean | null;
  formatted: string;
}

export type InvalidDateReason =
  "weekday_mismatch" | "not_a_date" | "range_end_before_start" | "unparseable";

export type ParsedDate =
  | { kind: "single"; start: LocalDate }
  | { kind: "window"; start: LocalDate; end: LocalDate }
  | { kind: "open"; start: LocalDate }
  | { kind: "invalid"; reason: InvalidDateReason }
  | { kind: "empty" };

type SingleResult =
  { ok: true; date: LocalDate } | { ok: false; reason: InvalidDateReason };

const WEEKDAY_INDEX: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7,
};

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAY = `(${Object.keys(WEEKDAY_INDEX).join("|")})\\.?,?`;
const MONTH = `(${Object.keys(MONTH_INDEX).join("|")})\\.?,?`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?,?";
const YEAR = "(\\d{4})";

// [weekday] d Month [yyyy]
const DAY_MONTH = new RegExp(`^(?:${WEEKDAY} )?${DAY} ${MONTH}(?: ${YEAR})?$`);
// [weekday] Month d [yyyy]
const MONTH_DAY = new RegExp(`^(?:${WEEKDAY} )?${MONTH} ${DAY}(?: ${YEAR})?$`);
const NUMERIC_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
const NUMERIC_DMY_DASH = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;
const NUMERIC_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

// "1-6 oct", "1 - 6 oct 2026": the end's month (and year) applies to the start.
const DAY_RANGE_SAME_MONTH = new RegExp(
  `^${DAY} ?- ?${DAY} ${MONTH}(?: ${YEAR})?$`,
);
// "28 sep - 2 oct", "28 sep to 2 oct"
const SPACED_RANGE = /^(.+?) (?:-|to) (.+)$/;
// "28 sep-2 oct": a dash without spaces after a month name
const TIGHT_RANGE = /^(.+?[a-z.])-(\d.*)$/;
const OPEN_FROM = /^from (.+)$/;
const OPEN_ONWARDS = /^(.+?) onwards?$/;

// Every dash-like character becomes "-" (hyphens, figure, en and em dashes, minus, full-width).
const DASHES = new RegExp(
  `[${[
    0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63,
    0xff0d,
  ]
    .map((code) => String.fromCharCode(code))
    .join("")}]`,
  "g",
);

export function normaliseDateText(text: string): string {
  return text.replace(DASHES, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The year for a day and month given without one (PRD 6.3.2 step 5). With a weekday: the year
 * among today's year and its neighbours whose date falls on that weekday, closest to today.
 * Without: the year that puts the date within 183 days of today.
 */
function inferYear(
  day: number,
  month: number,
  weekday: number | null,
  today: LocalDate,
): SingleResult {
  const year = yearOf(today);
  const candidates = [year - 1, year, year + 1]
    .map((y) => makeDate(y, month, day))
    .filter((d): d is LocalDate => d !== null);
  if (candidates.length === 0) return { ok: false, reason: "not_a_date" };

  const closest = (dates: LocalDate[]) =>
    dates.reduce((best, d) =>
      Math.abs(diffDays(d, today)) < Math.abs(diffDays(best, today)) ? d : best,
    );

  if (weekday !== null) {
    const matching = candidates.filter((d) => isoWeekday(d) === weekday);
    if (matching.length === 0) return { ok: false, reason: "weekday_mismatch" };
    return { ok: true, date: closest(matching) };
  }
  const near = candidates.filter((d) => Math.abs(diffDays(d, today)) <= 183);
  return { ok: true, date: closest(near.length > 0 ? near : candidates) };
}

function resolve(
  day: number,
  month: number,
  year: number | null,
  weekday: number | null,
  today: LocalDate,
): SingleResult {
  if (year === null) return inferYear(day, month, weekday, today);
  const date = makeDate(year, month, day);
  if (!date) return { ok: false, reason: "not_a_date" };
  if (weekday !== null && isoWeekday(date) !== weekday) {
    return { ok: false, reason: "weekday_mismatch" };
  }
  return { ok: true, date };
}

/** One date in any single form of PRD 6.3.2 step 4. Numeric forms are always day-first. */
function parseSingle(text: string, today: LocalDate): SingleResult {
  let match = NUMERIC_YMD.exec(text);
  if (match) return resolve(+match[3]!, +match[2]!, +match[1]!, null, today);

  match = NUMERIC_DMY.exec(text) ?? NUMERIC_DMY_DASH.exec(text);
  if (match) {
    const rawYear = match[3]!;
    const year =
      rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return resolve(+match[1]!, +match[2]!, year, null, today);
  }

  match = DAY_MONTH.exec(text);
  if (match) {
    const [, weekday, day, month, year] = match;
    return resolve(
      +day!,
      MONTH_INDEX[month!]!,
      year ? +year : null,
      weekday ? WEEKDAY_INDEX[weekday]! : null,
      today,
    );
  }

  match = MONTH_DAY.exec(text);
  if (match) {
    const [, weekday, month, day, year] = match;
    return resolve(
      +day!,
      MONTH_INDEX[month!]!,
      year ? +year : null,
      weekday ? WEEKDAY_INDEX[weekday]! : null,
      today,
    );
  }

  return { ok: false, reason: "unparseable" };
}

function toWindow(start: SingleResult, end: SingleResult): ParsedDate {
  if (!start.ok) return { kind: "invalid", reason: start.reason };
  if (!end.ok) return { kind: "invalid", reason: end.reason };
  if (end.date < start.date)
    return { kind: "invalid", reason: "range_end_before_start" };
  return { kind: "window", start: start.date, end: end.date };
}

/** Parses normalised text: open-ended first, then windows, then a single date (6.3.2 step 3). */
export function parseDateText(text: string, today: LocalDate): ParsedDate {
  if (text === "") return { kind: "empty" };

  const open = OPEN_FROM.exec(text) ?? OPEN_ONWARDS.exec(text);
  if (open) {
    const start = parseSingle(open[1]!, today);
    return start.ok
      ? { kind: "open", start: start.date }
      : { kind: "invalid", reason: start.reason };
  }

  const sameMonth = DAY_RANGE_SAME_MONTH.exec(text);
  if (sameMonth) {
    const [, startDay, endDay, month, year] = sameMonth;
    const suffix = ` ${month}${year ? ` ${year}` : ""}`;
    return toWindow(
      parseSingle(`${startDay}${suffix}`, today),
      parseSingle(`${endDay}${suffix}`, today),
    );
  }

  const range = SPACED_RANGE.exec(text) ?? TIGHT_RANGE.exec(text);
  if (range) {
    const start = parseSingle(range[1]!, today);
    const end = parseSingle(range[2]!, today);
    // Only a window when both sides are dates; otherwise fall through to a single date.
    if (start.ok || end.ok) return toWindow(start, end);
  }

  const single = parseSingle(text, today);
  return single.ok
    ? { kind: "single", start: single.date }
    : { kind: "invalid", reason: single.reason };
}

/** PRD 6.3.2: a real date cell (a Sheets serial number) is a single date; text is parsed. */
export function parsePlannedDate(
  cell: CellValue,
  today: LocalDate,
): ParsedDate {
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return { kind: "single", start: fromSheetsSerial(cell.value) };
  }
  const text = typeof cell.value === "string" ? cell.value : cell.formatted;
  return parseDateText(normaliseDateText(text ?? ""), today);
}
