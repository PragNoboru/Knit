import "server-only";

import { cache } from "react";
import { z } from "zod";

import { BannersData } from "@/lib/domain/banners";
import { LocalDateSchema, TRACKER_COLORS } from "@/lib/domain/cards";
import { DayViewData } from "@/lib/domain/day-view";
import { MonthData } from "@/lib/domain/month-view";
import {
  TaskDetail,
  TaskListData,
  type TaskListQuery,
} from "@/lib/domain/tasks-screens";
import { callRpc, getSupabase, RpcError } from "@/lib/supabase/server";
import { istDateTime, type LocalDate } from "@/lib/time";

/** Data for the screens (PRD 12), read as the signed-in user and parsed with zod. */

/**
 * Today in India, as the database's clock says (knit_today, PRD 9.1), once per request.
 * Invariant 1: the screens take today from here, never from the Node process clock, so they
 * agree with Today's data and with the injected clock in tests (PRD 17).
 */
export const getKnitToday = cache((): Promise<LocalDate> =>
  callRpc(LocalDateSchema, "knit_today"),
);

export function loadDayView(day: LocalDate | null): Promise<DayViewData> {
  return callRpc(DayViewData, "day_view", { p_day: day });
}

export function loadMonth(month: LocalDate): Promise<MonthData> {
  return callRpc(MonthData, "month_view", { p_month: month });
}

const RawBanners = BannersData.omit({ paused: true }).extend({
  paused: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      reason: z.string().nullable(),
      lastPullAt: z.string().nullable(),
    }),
  ),
});

export async function loadBanners(): Promise<BannersData> {
  const raw = await callRpc(RawBanners, "app_banners");
  return {
    ...raw,
    paused: raw.paused.map(({ lastPullAt, ...tracker }) => ({
      ...tracker,
      lastPull: lastPullAt === null ? null : istDateTime(lastPullAt),
    })),
  };
}

export function loadTaskList(query: TaskListQuery): Promise<TaskListData> {
  return callRpc(TaskListData, "task_list", {
    p_query: {
      search: query.search || null,
      from: query.from,
      to: query.to,
      trackerIds: query.trackerIds,
      statuses: query.statuses,
      everyone: query.everyone,
      page: query.page,
    },
  });
}

/** The drawer's task, or null when it does not exist or is not the caller's to see. */
export async function loadTaskDetail(
  taskId: string,
): Promise<TaskDetail | null> {
  if (!z.uuid().safeParse(taskId).success) return null;
  try {
    return await callRpc(TaskDetail.nullable(), "task_detail", {
      p_task_id: taskId,
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === "not_allowed") return null;
    throw error;
  }
}

const TrackerOption = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.enum(TRACKER_COLORS),
});
export type TrackerOption = z.infer<typeof TrackerOption>;

/** 12.3, 12.5 tracker filters: the trackers the caller may see (9.2 tracker_public). */
export async function loadTrackerOptions(): Promise<TrackerOption[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("tracker_public")
    .select("id, name, color")
    .order("name");
  if (error) throw new Error(`tracker_public read failed: ${error.code}`);
  return z.array(TrackerOption).parse(data);
}
