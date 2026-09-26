import { z } from "zod";

/** PRD 6.1: the statuses a user (or a source sheet) can set. `not_done` is close_day's alone. */
export const USER_STATUSES = [
  "yet_to_start",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

export const KNIT_STATUSES = [...USER_STATUSES, "not_done"] as const;

export type UserStatus = (typeof USER_STATUSES)[number];
export type KnitStatus = (typeof KNIT_STATUSES)[number];

export const KnitUserStatus = z.enum(USER_STATUSES);

/** A write-back word: a string to write, "" to clear the cell, null to leave it unchanged (N8). */
const WriteBackValue = z.string().nullable();

/**
 * PRD 8.2: the registry of one tracker, as the setup wizard saves it in trackers.config.
 * Header names are matched after trim, lowercase and whitespace collapse; statusMap keys are
 * stored normalised the same way ("" is the key for a blank cell).
 */
export const TrackerConfig = z.object({
  headerRow: z.number().int().min(1),
  columns: z.object({
    date: z.string().min(1),
    title: z.string().min(1),
    statusRead: z.string().min(1),
    statusWrite: z.string().min(1).nullable(),
    completedOn: z.string().min(1).nullable(),
    owner: z.string().min(1).nullable(),
    sourceRef: z.string().min(1).nullable(),
    critical: z
      .object({ header: z.string().min(1), truthy: z.array(z.string()) })
      .nullable(),
  }),
  readOnlyColumns: z.array(z.string()),
  titleTemplate: z.string().min(1),
  subtitleTemplate: z.string().nullable(),
  detailColumns: z.array(z.string()).max(8),
  ownerSeparators: z.array(z.string().min(1)).default([","]),
  ownerFilter: z.enum(["mine", "all"]).default("mine"),
  offDayPolicy: z
    .enum(["previous_working_day", "next_working_day", "keep"])
    .default("previous_working_day"),
  statusMap: z.record(z.string(), KnitUserStatus),
  cancelReasons: z.record(z.string(), z.string()).default({}),
  writeBack: z.object({
    yet_to_start: WriteBackValue,
    in_progress: WriteBackValue,
    blocked: WriteBackValue,
    done: WriteBackValue,
    cancelled: WriteBackValue,
  }),
  completedOnFormat: z.union([
    z.object({ type: z.literal("date") }),
    z.object({ type: z.literal("text"), pattern: z.string().min(1) }),
    z.null(),
  ]),
});

export type TrackerConfig = z.infer<typeof TrackerConfig>;
export type OffDayPolicy = TrackerConfig["offDayPolicy"];

/** PRD 6.7, 6.8, 8.2: trim, lowercase, collapse whitespace (same as knit_normalise in SQL). */
export function normaliseKey(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
