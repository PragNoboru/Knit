import { CircleAlert, Clock, TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { Banner } from "@/lib/domain/banners";
import { cn } from "@/lib/utils";

// PRD 12.3 banners (top of Today, in priority order), 12.7 "Tracker cannot sync".
export function Banners({
  banners,
  isAdmin,
}: {
  banners: Banner[];
  isAdmin: boolean;
}) {
  if (banners.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {banners.map((banner) => {
        const style = {
          not_closed:
            "border-red-300 bg-red-50 text-red-900 dark:border-red-400/40 dark:bg-red-400/10 dark:text-red-200",
          paused:
            "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200",
          heads_up:
            "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-400/40 dark:bg-sky-400/10 dark:text-sky-200",
        }[banner.kind];
        const Icon = {
          not_closed: CircleAlert,
          paused: TriangleAlert,
          heads_up: Clock,
        }[banner.kind];
        return (
          <div
            key={banner.kind === "paused" ? banner.trackerId : banner.kind}
            role={banner.kind === "heads_up" ? "status" : "alert"}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
              style,
            )}
          >
            <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p className="flex-1">{banner.text}</p>
            {banner.kind === "not_closed" ? (
              <Link href="/admin/sync" className="font-medium underline">
                Sync health
              </Link>
            ) : null}
            {banner.kind === "paused" && isAdmin ? (
              <Link
                href={`/admin/trackers/${banner.trackerId}`}
                className="font-medium underline"
              >
                Fix
              </Link>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
