import { z } from "zod";

import { formatDay, type LocalDate } from "@/lib/time";

import { LocalDateSchema, TaskCard, TaskDayInfo } from "./cards";
import { KNIT_STATUSES, type KnitStatus } from "./config";
import { STATUS_LABELS } from "./status";

/** PRD 12.5 (All Tasks) and 12.6 (the task drawer): what the database returns for them. */

export const TaskListData = z.object({
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  rows: z.array(TaskCard),
});
export type TaskListData = z.infer<typeof TaskListData>;

const list = (value: unknown) =>
  typeof value === "string" && value !== "" ? value.split(",") : [];

/**
 * 12.5 filters, read from the URL (?q=&from=&to=&tracker=a,b&status=done&everyone=1&page=2).
 * Anything malformed is dropped rather than failing the page.
 */
export const TaskListQuery = z.object({
  search: z.string().trim().max(200).catch(""),
  from: LocalDateSchema.nullable().catch(null),
  to: LocalDateSchema.nullable().catch(null),
  trackerIds: z.preprocess(list, z.array(z.uuid())).catch([]),
  statuses: z.preprocess(list, z.array(z.enum(KNIT_STATUSES))).catch([]),
  everyone: z.preprocess((v) => v === "1", z.boolean()).catch(false),
  page: z.coerce.number().int().min(1).max(10_000).catch(1),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

export function parseTaskListQuery(
  params: Record<string, string | string[] | undefined>,
): TaskListQuery {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  return TaskListQuery.parse({
    search: one("q") ?? "",
    from: one("from") ?? null,
    to: one("to") ?? null,
    trackerIds: one("tracker"),
    statuses: one("status"),
    everyone: one("everyone"),
    page: one("page") ?? 1,
  });
}

export const TaskEvent = z.object({
  id: z.number().int(),
  at: z.string(),
  origin: z.enum(["hub", "source", "system", "correction"]),
  field: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  reason: z.string().nullable(),
  actor: z.string().nullable(),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskDetail = z.object({
  card: TaskCard,
  details: z.record(z.string(), z.string()),
  detailOrder: z.array(z.string()),
  ownerRaw: z.string().nullable(),
  taskDays: z.array(TaskDayInfo),
  events: z.array(TaskEvent),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/**
 * 12.6, N75: who the task belongs to, as the drawer lists it. Without a checking owner column,
 * the owner cell as "Owner". With one, "Owner" is the checker cell and "Maker" the owner cell,
 * or the checker cell when the owner cell is blank (N72: the Owner is then the maker).
 */
export function ownerFacts(
  detail: Pick<TaskDetail, "ownerRaw"> & { card: Pick<TaskCard, "checker"> },
): { label: string; value: string }[] {
  const checker = detail.card.checker;
  if (!checker) return [{ label: "Owner", value: detail.ownerRaw || "None" }];
  return [
    { label: "Owner", value: checker.raw || "None" },
    { label: "Maker", value: detail.ownerRaw || checker.raw || "None" },
  ];
}

/**
 * 12.6: detail columns as label and value pairs, in the tracker's order. N73: the checking
 * owner's text, kept with the details, is left out: the drawer shows it as the Owner.
 */
export function detailPairs(
  detail: Pick<TaskDetail, "details" | "detailOrder"> & {
    card?: Pick<TaskCard, "checker">;
  },
): { label: string; value: string }[] {
  const byKey = new Map(
    Object.entries(detail.details).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const seen = new Set<string>();
  const checker = detail.card?.checker?.header.toLowerCase();
  if (checker !== undefined) seen.add(checker);
  const pairs: { label: string; value: string }[] = [];
  for (const label of detail.detailOrder) {
    const key = label.toLowerCase();
    const value = byKey.get(key);
    if (value === undefined || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ label, value });
  }
  for (const [key, value] of Object.entries(detail.details)) {
    if (!seen.has(key.toLowerCase())) pairs.push({ label: key, value });
  }
  return pairs;
}

const ORIGINS: Record<TaskEvent["origin"], string> = {
  hub: "in Knit",
  source: "in the sheet",
  system: "by Knit",
  correction: "by correction",
};

const statusLabel = (value: string | null) =>
  value !== null && (KNIT_STATUSES as readonly string[]).includes(value)
    ? STATUS_LABELS[value as KnitStatus]
    : (value ?? "none");

const dayLabel = (value: string | null) =>
  value !== null && LocalDateSchema.safeParse(value).success
    ? formatDay(value as LocalDate)
    : (value ?? "none");

/** 12.6: one history line: what changed (who, from where and when are shown beside it). */
export function describeEvent(event: TaskEvent): {
  what: string;
  where: string;
  who: string;
} {
  let what: string;
  switch (event.field) {
    case "status":
      what = `${statusLabel(event.oldValue)} → ${statusLabel(event.newValue)}`;
      break;
    case "due_date":
      what = `Due date ${dayLabel(event.oldValue)} → ${dayLabel(event.newValue)}`;
      break;
    case "removed":
    // planPull records a removal (N11) under this field. Before N30 changed (1 Oct 2026) a
    // row put back recorded "restored" under it too.
    case "removed_at_source":
      what =
        event.newValue === "restored"
          ? "Back in the sheet"
          : "Removed from the sheet";
      break;
    default:
      what = `${event.field}: ${event.oldValue ?? "none"} → ${event.newValue ?? "none"}`;
  }
  if (event.reason) what = `${what} (${event.reason})`;
  const who =
    event.actor ??
    (event.origin === "source"
      ? "Sheet"
      : event.origin === "system"
        ? "Knit"
        : "");
  return { what, where: ORIGINS[event.origin], who };
}
