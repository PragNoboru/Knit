import { z } from "zod";

import { formatDay, type LocalDate } from "@/lib/time";

import { LocalDateSchema } from "./cards";

/**
 * PRD 12.3 banners, in priority order: yesterday not closed (admin, from 08:00 IST, 10.5 step
 * 4); a paused tracker (14); the evening heads-up after 17:30 IST (D4). app_banners returns
 * the facts; the caller passes the time in India, so this stays pure.
 */

export const BannersData = z.object({
  today: LocalDateSchema,
  isAdmin: z.boolean(),
  yesterdayNotClosed: z.boolean(),
  paused: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      reason: z.string().nullable(),
      /** When the tracker was last read, as seen in India. */
      lastPull: z
        .object({ date: LocalDateSchema, time: z.string() })
        .nullable(),
    }),
  ),
  openToday: z.number().int().min(0),
  nextWorkingDay: LocalDateSchema.nullable(),
});
export type BannersData = z.infer<typeof BannersData>;

export type Banner =
  | { kind: "not_closed"; text: string }
  | { kind: "paused"; trackerId: string; text: string }
  | { kind: "heads_up"; text: string };

export const NOT_CLOSED_FROM = 8 * 60; // 08:00 IST
export const HEADS_UP_FROM = 17 * 60 + 30; // 17:30 IST

/** `minutes`: minutes since midnight in India (lib/time minutesIST). */
export function buildBanners(data: BannersData, minutes: number): Banner[] {
  const banners: Banner[] = [];
  if (data.isAdmin && data.yesterdayNotClosed && minutes >= NOT_CLOSED_FROM) {
    banners.push({
      kind: "not_closed",
      text: "Yesterday is not closed yet. Check Sync health.",
    });
  }
  for (const tracker of data.paused) {
    banners.push({
      kind: "paused",
      trackerId: tracker.id,
      text: pausedText(tracker, data.today),
    });
  }
  if (
    minutes >= HEADS_UP_FROM &&
    data.openToday > 0 &&
    data.nextWorkingDay !== null
  ) {
    banners.push({
      kind: "heads_up",
      text: headsUpText(data.openToday, data.nextWorkingDay),
    });
  }
  return banners;
}

/** "Sapiens paused: column 'Status' not found. Showing data from 10:40." */
function pausedText(
  tracker: BannersData["paused"][number],
  today: LocalDate,
): string {
  const paused = tracker.reason
    ? `${tracker.name} paused: ${tracker.reason}.`
    : `${tracker.name} paused.`;
  if (tracker.lastPull === null) return paused;
  // N18: a last read on an earlier day also names the day.
  const when =
    tracker.lastPull.date === today
      ? tracker.lastPull.time
      : `${formatDay(tracker.lastPull.date)}, ${tracker.lastPull.time}`;
  return `${paused} Showing data from ${when}.`;
}

/** "3 tasks are still open. At midnight they move to Mon 5 Oct." (N18: one task reads as one). */
function headsUpText(open: number, next: LocalDate): string {
  return open === 1
    ? `1 task is still open. At midnight it moves to ${formatDay(next)}.`
    : `${open} tasks are still open. At midnight they move to ${formatDay(next)}.`;
}
