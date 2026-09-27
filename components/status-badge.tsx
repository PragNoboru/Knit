import {
  Ban,
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  type LucideIcon,
} from "lucide-react";

import type { KnitStatus } from "@/lib/domain/config";
import { STATUS_LABELS } from "@/lib/domain/status";
import { cn } from "@/lib/utils";

// PRD 12.2: a status never relies on colour alone; each has an icon and its label.
export const STATUS_ICONS: Record<KnitStatus, LucideIcon> = {
  yet_to_start: Circle,
  in_progress: CircleDot,
  blocked: Ban,
  done: CircleCheck,
  cancelled: CircleSlash,
  not_done: CircleX,
};

export const STATUS_TEXT: Record<KnitStatus, string> = {
  yet_to_start: "text-muted-foreground",
  in_progress: "text-sky-700 dark:text-sky-300",
  blocked: "text-amber-700 dark:text-amber-300",
  done: "text-emerald-700 dark:text-emerald-300",
  cancelled: "text-muted-foreground",
  not_done: "text-red-700 dark:text-red-300",
};

export function StatusIcon({
  status,
  className,
}: {
  status: KnitStatus;
  className?: string;
}) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      aria-hidden
      className={cn("size-4 shrink-0", STATUS_TEXT[status], className)}
    />
  );
}

export function StatusBadge({
  status,
  className,
}: {
  status: KnitStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        className,
      )}
    >
      <StatusIcon status={status} />
      <span>{STATUS_LABELS[status]}</span>
    </span>
  );
}
