import { z } from "zod";

import { formatDay, type LocalDate } from "@/lib/time";

import { compareCards, LocalDateSchema, rowStatus, TaskCard } from "./cards";
import { KNIT_STATUSES, type KnitStatus } from "./config";

/**
 * PRD 12.3, 12.4, 12.7: the Today and Day views. The database returns the caller's cards for
 * the day (day_view); this module decides the groups, their order and the empty states, so
 * the rules are tested here and React only draws them.
 */

export const DayViewData = z.object({
  day: LocalDateSchema,
  today: LocalDateSchema,
  isWorking: z.boolean(),
  offReason: z.string().nullable(),
  nextWorkingDay: LocalDateSchema.nullable(),
  isAdmin: z.boolean(),
  hasTasks: z.boolean(),
  hasTrackers: z.boolean(),
  adminContact: z.object({ name: z.string(), email: z.string() }).nullable(),
  rows: z.array(TaskCard),
  ongoing: z.array(TaskCard),
  pulledForward: z.array(TaskCard),
  earlyDone: z.array(TaskCard),
  upcoming: z.array(TaskCard),
  nextDayRows: z.array(TaskCard),
});
export type DayViewData = z.infer<typeof DayViewData>;

export type GroupKey =
  "spillover" | "due" | "ongoing" | "pulled_forward" | "blocked" | "done";

/** PRD 12.3: the groups, in this order. */
export const GROUP_ORDER: readonly GroupKey[] = [
  "spillover",
  "due",
  "ongoing",
  "pulled_forward",
  "blocked",
  "done",
];

const TODAY_TITLES: Record<GroupKey, string> = {
  spillover: "Spillover",
  due: "Due today",
  ongoing: "Ongoing",
  pulled_forward: "Pulled forward",
  blocked: "Blocked",
  done: "Done today",
};

// N18: on another day the groups drop "today" from their titles.
const DAY_TITLES: Record<GroupKey, string> = {
  ...TODAY_TITLES,
  due: "Due",
  done: "Done",
};

export interface DayRow {
  card: TaskCard;
  /** 12.3: completed early today (a later task-day marked done). */
  early: boolean;
}

export interface DayGroup {
  key: GroupKey;
  title: string;
  rows: DayRow[];
  /** 12.3: Done today is collapsed by default. */
  collapsed: boolean;
}

export type DayNotice =
  | { kind: "no_trackers" }
  | {
      kind: "no_tasks";
      adminContact: { name: string; email: string } | null;
    }
  | { kind: "off_day"; reason: string; nextWorkingDay: LocalDate | null }
  | { kind: "nothing_planned"; upcoming: TaskCard[] }
  | {
      kind: "all_clear";
      done: number;
      nextWorkingDay: LocalDate | null;
      nextDayRows: TaskCard[];
    }
  | { kind: "nothing_scheduled" }
  | { kind: "nothing_planned_day" }
  | { kind: "no_match" };

export interface DayFilters {
  trackerIds: readonly string[];
  statuses: readonly KnitStatus[];
}

export const NO_FILTERS: DayFilters = { trackerIds: [], statuses: [] };

export interface DayView {
  day: LocalDate;
  when: "past" | "today" | "future";
  header: string;
  notice: DayNotice | null;
  groups: DayGroup[];
}

const isFinished = (card: TaskCard) => {
  const status = rowStatus(card);
  return status === "done" || status === "cancelled";
};

/**
 * PRD 12.3: "Thu 24 Sep · 4 of 9 done · 2 spilled in". The count is the day's task-days
 * without the cancelled ones; parts with nothing to count are left out (N18).
 */
export function dayHeader(day: LocalDate, rows: readonly TaskCard[]): string {
  const counted = rows.filter((card) => rowStatus(card) !== "cancelled");
  const done = counted.filter((card) => rowStatus(card) === "done").length;
  const spilled = rows.filter(
    (card) => (card.taskDay?.spillIndex ?? 0) > 0,
  ).length;
  const parts = [formatDay(day)];
  if (counted.length > 0) parts.push(`${done} of ${counted.length} done`);
  if (spilled > 0) parts.push(`${spilled} spilled in`);
  return parts.join(" · ");
}

/** Where one of the day's task-days goes (12.3 groups 1, 2, 5 and 6). */
function groupOfDayRow(card: TaskCard): GroupKey {
  const status = rowStatus(card);
  if (status === "done" || status === "cancelled") return "done";
  if (status === "blocked") return "blocked";
  return (card.taskDay?.spillIndex ?? 0) > 0 ? "spillover" : "due";
}

export function buildDayView(
  data: DayViewData,
  filters: DayFilters = NO_FILTERS,
): DayView {
  const when =
    data.day < data.today
      ? "past"
      : data.day === data.today
        ? "today"
        : "future";
  const titles = when === "today" ? TODAY_TITLES : DAY_TITLES;
  const matches = (card: TaskCard) =>
    (filters.trackerIds.length === 0 ||
      filters.trackerIds.includes(card.tracker.id)) &&
    (filters.statuses.length === 0 ||
      filters.statuses.includes(rowStatus(card)));

  // N18: a task appears once, in the first group that takes it.
  const rows: Record<GroupKey, DayRow[]> = {
    spillover: [],
    due: [],
    ongoing: [],
    pulled_forward: [],
    blocked: [],
    done: [],
  };
  const placed = new Set<string>();
  const place = (key: GroupKey, card: TaskCard, early = false) => {
    if (placed.has(card.taskId)) return;
    placed.add(card.taskId);
    if (matches(card)) rows[key].push({ card, early });
  };
  for (const card of data.rows) place(groupOfDayRow(card), card);
  // 6.3.3: windows and open-ended tasks are ongoing on working days.
  if (data.isWorking) for (const card of data.ongoing) place("ongoing", card);
  for (const card of data.pulledForward) place("pulled_forward", card);
  for (const card of data.earlyDone) place("done", card, true);

  const groups = GROUP_ORDER.filter((key) => rows[key].length > 0).map(
    (key) => ({
      key,
      title: titles[key],
      rows: [...rows[key]].sort((a, b) => compareCards(a.card, b.card)),
      collapsed: key === "done",
    }),
  );

  let notice = noticeFor(data, when);
  const filtering = filters.trackerIds.length + filters.statuses.length > 0;
  if (notice === null && filtering && groups.length === 0)
    notice = { kind: "no_match" };
  return {
    day: data.day,
    when,
    header: dayHeader(data.day, data.rows),
    notice,
    groups,
  };
}

/** PRD 12.7: the message for the day, from the unfiltered data. */
function noticeFor(data: DayViewData, when: DayView["when"]): DayNotice | null {
  if (data.isAdmin && !data.hasTrackers) return { kind: "no_trackers" };
  if (!data.isAdmin && !data.hasTasks)
    return { kind: "no_tasks", adminContact: data.adminContact };
  if (data.rows.length === 0) {
    if (!data.isWorking)
      return {
        kind: "off_day",
        reason: data.offReason ?? "",
        nextWorkingDay: data.nextWorkingDay,
      };
    if (when === "today")
      return { kind: "nothing_planned", upcoming: data.upcoming };
    return when === "past"
      ? { kind: "nothing_scheduled" }
      : { kind: "nothing_planned_day" };
  }
  if (when === "today" && data.rows.every(isFinished)) {
    const done =
      data.rows.filter((card) => rowStatus(card) === "done").length +
      data.earlyDone.length;
    return {
      kind: "all_clear",
      done,
      nextWorkingDay: data.nextWorkingDay,
      nextDayRows: [...data.nextDayRows].sort(compareCards),
    };
  }
  return null;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** PRD 12.7: the copy for each notice (N18 adds the last three). */
export function noticeText(notice: DayNotice): string {
  switch (notice.kind) {
    case "no_trackers":
      return "Connect your first tracker.";
    case "no_tasks":
      return "No trackers are connected to your account yet.";
    case "off_day":
      return `Day off (${notice.reason}). Nothing is due or spills here.`;
    case "nothing_planned":
      return "Nothing is planned for today.";
    case "all_clear":
      return `All clear for today. ${plural(notice.done, "task", "tasks")} done.`;
    case "nothing_scheduled":
      return "Nothing was scheduled on this day.";
    case "nothing_planned_day":
      return "Nothing is planned for this day.";
    case "no_match":
      return "No tasks match these filters.";
  }
}

const commaList = (value: unknown) =>
  typeof value === "string" && value !== "" ? value.split(",") : [];

const DayFiltersSchema = z.object({
  trackerIds: z.preprocess(commaList, z.array(z.uuid())).catch([]),
  statuses: z.preprocess(commaList, z.array(z.enum(KNIT_STATUSES))).catch([]),
});

/** 12.3 filters from the URL (?tracker=a,b&status=blocked); anything malformed is ignored. */
export function parseDayFilters(tracker: unknown, status: unknown): DayFilters {
  return DayFiltersSchema.parse({ trackerIds: tracker, statuses: status });
}
