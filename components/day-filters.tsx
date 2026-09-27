"use client";

import { ListFilter } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { StatusBadge } from "@/components/status-badge";
import { TrackerChip } from "@/components/tracker-chip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TrackerColor } from "@/lib/domain/cards";
import { KNIT_STATUSES, type KnitStatus } from "@/lib/domain/config";

/** PRD 12.3 filters: tracker (several at once) and status, kept in the URL. */
export function DayFilters({
  trackers,
  selectedTrackers,
  selectedStatuses,
}: {
  trackers: { id: string; name: string; color: TrackerColor }[];
  selectedTrackers: readonly string[];
  selectedStatuses: readonly KnitStatus[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const update = (key: "tracker" | "status", values: readonly string[]) => {
    const next = new URLSearchParams(params.toString());
    if (values.length === 0) next.delete(key);
    else next.set(key, values.join(","));
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };
  const toggle = <T extends string>(list: readonly T[], value: T) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" />}
          disabled={trackers.length === 0}
        >
          <ListFilter aria-hidden />
          Trackers
          {selectedTrackers.length > 0 ? ` (${selectedTrackers.length})` : ""}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60">
          {trackers.map((tracker) => (
            <DropdownMenuCheckboxItem
              key={tracker.id}
              checked={selectedTrackers.includes(tracker.id)}
              onCheckedChange={() =>
                update("tracker", toggle(selectedTrackers, tracker.id))
              }
            >
              <TrackerChip name={tracker.name} color={tracker.color} />
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          <ListFilter aria-hidden />
          Status
          {selectedStatuses.length > 0 ? ` (${selectedStatuses.length})` : ""}
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-48">
          {KNIT_STATUSES.map((status) => (
            <DropdownMenuCheckboxItem
              key={status}
              checked={selectedStatuses.includes(status)}
              onCheckedChange={() =>
                update("status", toggle(selectedStatuses, status))
              }
            >
              <StatusBadge status={status} />
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedTrackers.length + selectedStatuses.length > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.delete("tracker");
            next.delete("status");
            const query = next.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, {
              scroll: false,
            });
          }}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
