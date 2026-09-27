import type { Metadata } from "next";
import Link from "next/link";

import { STATUS_LABELS } from "@/lib/domain/status";
import { TaskList } from "@/components/task-list";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KNIT_STATUSES } from "@/lib/domain/config";
import { parseTaskListQuery } from "@/lib/domain/tasks-screens";
import { loadTaskList, loadTrackerOptions } from "@/lib/screens";
import { getCurrentUser } from "@/lib/supabase/server";
import { todayIST } from "@/lib/time";
import { firstParam, hrefWith } from "@/lib/url";

import { DrawerSlot } from "../_parts/drawer-slot";

export const metadata: Metadata = { title: "All Tasks · Knit" };

const SELECT =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

// PRD 12.5: All Tasks, with filters, a title search and 50 per page.
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = parseTaskListQuery(params);
  const [user, list, trackers] = await Promise.all([
    getCurrentUser(),
    loadTaskList(query),
    loadTrackerOptions(),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const pageHref = (page: number) =>
    hrefWith("/tasks", params, { page: page === 1 ? null : String(page) });

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">All Tasks</h1>
      <form
        method="get"
        action="/tasks"
        className="grid grid-cols-2 gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto]"
      >
        <div className="col-span-2 grid gap-1.5 sm:col-span-3 lg:col-span-1">
          <Label htmlFor="q">Search titles</Label>
          <Input id="q" name="q" type="search" defaultValue={query.search} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input
            id="from"
            name="from"
            type="date"
            defaultValue={query.from ?? ""}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={query.to ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tracker">Tracker</Label>
          <select
            id="tracker"
            name="tracker"
            defaultValue={query.trackerIds[0] ?? ""}
            className={SELECT}
          >
            <option value="">All trackers</option>
            {trackers.map((tracker) => (
              <option key={tracker.id} value={tracker.id}>
                {tracker.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={query.statuses[0] ?? ""}
            className={SELECT}
          >
            <option value="">All statuses</option>
            {KNIT_STATUSES.filter((s) => s !== "not_done").map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2 flex flex-wrap items-end gap-3 sm:col-span-3 lg:col-span-1">
          {user?.isAdmin ? (
            <label className="flex h-8 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="everyone"
                value="1"
                defaultChecked={query.everyone}
                className="size-4 accent-foreground"
              />
              Everyone
            </label>
          ) : null}
          <button type="submit" className={buttonVariants({ size: "sm" })}>
            Apply
          </button>
          <Link
            href="/tasks"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Clear
          </Link>
        </div>
      </form>

      <p className="text-sm text-muted-foreground" role="status">
        {list.total === 0
          ? "No tasks match these filters."
          : `${list.total} ${list.total === 1 ? "task" : "tasks"} · page ${list.page} of ${pages}`}
      </p>
      {list.rows.length > 0 ? (
        <TaskList
          rows={list.rows}
          today={todayIST()}
          drawerHref={(taskId) => hrefWith("/tasks", params, { task: taskId })}
        />
      ) : null}
      {pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center gap-2">
          {list.page > 1 ? (
            <Link
              href={pageHref(list.page - 1)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Previous
            </Link>
          ) : null}
          {list.page < pages ? (
            <Link
              href={pageHref(list.page + 1)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Next
            </Link>
          ) : null}
        </nav>
      ) : null}
      <DrawerSlot
        taskId={firstParam(params, "task")}
        closeHref={hrefWith("/tasks", params, { task: null })}
      />
    </div>
  );
}
