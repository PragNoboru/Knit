import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import Link from "next/link";

import { Banners } from "@/components/banners";
import { DayFilters } from "@/components/day-filters";
import { DayGroups } from "@/components/day-groups";
import { buttonVariants } from "@/components/ui/button";
import { buildBanners } from "@/lib/domain/banners";
import { buildDayView, parseDayFilters } from "@/lib/domain/day-view";
import { loadBanners, loadDayView, loadTrackerOptions } from "@/lib/screens";
import { RpcError } from "@/lib/supabase/server";
import { addDays, minutesIST, type LocalDate } from "@/lib/time";
import { firstParam, hrefWith, type SearchParams } from "@/lib/url";

import { DrawerSlot } from "./drawer-slot";

/**
 * PRD 12.3, 12.4: Today and the Day view share one layout: header, filters, groups, and the
 * drawer. Only Today shows the banners.
 */
export async function DayScreen({
  day,
  path,
  params,
  banners = false,
  navigation = true,
}: {
  /** null: today, as the database sees it. */
  day: LocalDate | null;
  path: string;
  params: SearchParams;
  banners?: boolean;
  navigation?: boolean;
}) {
  let data;
  try {
    data = await loadDayView(day);
  } catch (error) {
    if (error instanceof RpcError && error.code === "calendar_not_covered") {
      return (
        <p className="rounded-xl border bg-card p-5 font-medium">
          The calendar does not cover this date yet.
        </p>
      );
    }
    throw error;
  }
  const [bannerData, trackers] = await Promise.all([
    banners ? loadBanners() : null,
    loadTrackerOptions(),
  ]);
  const filters = parseDayFilters(
    firstParam(params, "tracker"),
    firstParam(params, "status"),
  );
  const view = buildDayView(data, filters);
  const dayHref = (target: LocalDate) =>
    target === data.today ? "/" : `/day/${target}`;
  const closed =
    view.when === "past" &&
    data.rows.length > 0 &&
    data.rows.every((card) => card.taskDay?.locked);

  return (
    <div className="flex flex-col gap-5">
      {bannerData ? (
        <Banners
          banners={buildBanners(bannerData, minutesIST())}
          isAdmin={bannerData.isAdmin}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {navigation ? (
            <Link
              href={dayHref(addDays(data.day, -1))}
              aria-label="Previous day"
              className={buttonVariants({ variant: "outline", size: "icon" })}
            >
              <ChevronLeft aria-hidden />
            </Link>
          ) : null}
          <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
            {view.header}
          </h1>
          {closed ? (
            <Lock
              aria-label="Closed"
              className="size-4 text-muted-foreground"
            />
          ) : null}
          {navigation ? (
            <Link
              href={dayHref(addDays(data.day, 1))}
              aria-label="Next day"
              className={buttonVariants({ variant: "outline", size: "icon" })}
            >
              <ChevronRight aria-hidden />
            </Link>
          ) : null}
          {navigation && view.when !== "today" ? (
            <Link
              href="/"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Today
            </Link>
          ) : null}
        </div>
        <DayFilters
          trackers={trackers}
          selectedTrackers={filters.trackerIds}
          selectedStatuses={filters.statuses}
        />
      </div>
      <DayGroups
        view={view}
        today={data.today}
        drawerHref={(taskId) => hrefWith(path, params, { task: taskId })}
      />
      <DrawerSlot
        taskId={firstParam(params, "task")}
        closeHref={hrefWith(path, params, { task: null })}
      />
    </div>
  );
}
