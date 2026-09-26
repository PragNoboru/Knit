/**
 * The only module that knows the timezone (CLAUDE.md invariant 1, PRD 14).
 *
 * Business dates are plain "yyyy-mm-dd" strings meaning a day in Asia/Kolkata. They never pass
 * through a local-time Date: arithmetic runs on day numbers computed with Date.UTC, which does
 * not depend on the machine's timezone.
 */

export const IST = "Asia/Kolkata";

/** A calendar day, "yyyy-mm-dd". */
export type LocalDate = string;

export const WEEKDAYS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;
export const WEEKDAYS_LONG = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** The date for a year, month (1-12) and day, or null when that day does not exist. */
export function makeDate(
  year: number,
  month: number,
  day: number,
): LocalDate | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
    return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  return (
    match !== null && makeDate(+match[1]!, +match[2]!, +match[3]!) === value
  );
}

function parts(date: LocalDate): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`Not a date: ${date}`);
  return { year: +match[1]!, month: +match[2]!, day: +match[3]! };
}

/** Days since 1970-01-01. */
export function toDayNumber(date: LocalDate): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

export function fromDayNumber(dayNumber: number): LocalDate {
  const d = new Date(dayNumber * MS_PER_DAY);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** a minus b, in days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

/** ISO weekday: Monday 1 ... Sunday 7. */
export function isoWeekday(date: LocalDate): number {
  return ((((toDayNumber(date) + 3) % 7) + 7) % 7) + 1;
}

export function yearOf(date: LocalDate): number {
  return parts(date).year;
}

export function monthOf(date: LocalDate): number {
  return parts(date).month;
}

export function dayOfMonth(date: LocalDate): number {
  return parts(date).day;
}

export function minDate(a: LocalDate, b: LocalDate): LocalDate {
  return a <= b ? a : b;
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

/** Google Sheets serial dates count days from 1899-12-30; any time part is dropped. */
const SHEETS_EPOCH_DAY = toDayNumber("1899-12-30");

export function fromSheetsSerial(serial: number): LocalDate {
  return fromDayNumber(SHEETS_EPOCH_DAY + Math.floor(serial));
}

export function toSheetsSerial(date: LocalDate): number {
  return toDayNumber(date) - SHEETS_EPOCH_DAY;
}

/**
 * Formats with a small subset of date-fns tokens: EEEE, EEE, d, dd, MMMM, MMM, MM, M, yyyy, yy.
 * Text in single quotes is literal. Used for "Mon 28 Sep" (PRD 6.9) and completedOnFormat (6.8).
 */
export function formatDate(date: LocalDate, pattern: string): string {
  const { year, month, day } = parts(date);
  const weekday = isoWeekday(date) - 1;
  const tokens: Record<string, string> = {
    EEEE: WEEKDAYS_LONG[weekday]!,
    EEE: WEEKDAYS[weekday]!,
    dd: pad(day),
    d: String(day),
    MMMM: MONTHS_LONG[month - 1]!,
    MMM: MONTHS[month - 1]!,
    MM: pad(month),
    M: String(month),
    yyyy: pad(year, 4),
    yy: pad(year % 100),
  };
  return pattern.replace(
    /'([^']*)'|EEEE|EEE|dd|d|MMMM|MMM|MM|M|yyyy|yy/g,
    (token, literal) =>
      literal !== undefined ? literal : (tokens[token] ?? token),
  );
}

/** "Mon 28 Sep" (PRD 6.9: EEE d MMM). */
export function formatDay(date: LocalDate): string {
  return formatDate(date, "EEE d MMM");
}

function istParts(now: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
}

/** Today in India. The clock is a parameter so callers and tests can freeze it. */
export function todayIST(now: Date = new Date()): LocalDate {
  const p = istParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since midnight in India, for time-of-day rules such as the 17:30 heads-up (D4). */
export function minutesIST(now: Date = new Date()): number {
  const p = istParts(now);
  return Number(p.hour) * 60 + Number(p.minute);
}
