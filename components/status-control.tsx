"use client";

import { Lock } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";

import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { useSyncState } from "@/components/sync-provider";
import { SyncPill } from "@/components/sync-pill";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { pullForward, setTaskStatus } from "@/lib/actions/tasks";
import type { SyncState } from "@/lib/domain/cards";
import {
  USER_STATUSES,
  type KnitStatus,
  type UserStatus,
} from "@/lib/domain/config";
import { needsReason, STATUS_LABELS } from "@/lib/domain/status";
import { cn } from "@/lib/utils";

/**
 * PRD 12.3: the status dropdown (arrows and Enter work, 12.2). The change shows at once and
 * rolls back if the database refuses it; the refusal is shown in plain language.
 */
export function StatusControl({
  taskId,
  title,
  status,
  enabled,
  locked = false,
  sync,
  pull = false,
  className,
}: {
  taskId: string;
  title: string;
  status: KnitStatus;
  enabled: boolean;
  /** A locked task-day shows a lock (12.4). */
  locked?: boolean;
  sync: SyncState;
  /** A later task-day: pulling forward (13 pullForward). */
  pull?: boolean;
  className?: string;
}) {
  const [syncState, setSyncState] = useSyncState(taskId, sync);
  const [shown, setShown] = useOptimistic(status);
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<"blocked" | "cancelled" | null>(null);

  const apply = (next: UserStatus, reason?: string) => {
    setError(null);
    startTransition(async () => {
      setShown(next);
      const action = pull ? pullForward : setTaskStatus;
      const result = await action({ taskId, status: next, reason });
      if (!result.ok) setError(result.error);
      else setSyncState(result.data.sync);
    });
  };

  if (!enabled) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input/60 px-2.5 text-muted-foreground">
          <StatusBadge status={status} />
          {locked ? (
            <Lock aria-label="Closed" className="size-3.5 shrink-0" />
          ) : null}
        </span>
        <SyncPill state={syncState} />
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={shown}
          disabled={busy}
          onValueChange={(value) => {
            if (value === null || value === shown) return;
            const next = value as UserStatus;
            if (needsReason(next)) setAsking(next as "blocked" | "cancelled");
            else apply(next);
          }}
        >
          <SelectTrigger
            aria-label={`Status of ${title}`}
            className="w-full sm:w-40"
          >
            <SelectValue>
              {(value: KnitStatus) => <StatusBadge status={value} />}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {USER_STATUSES.map((option) => (
              <SelectItem
                key={option}
                value={option}
                label={STATUS_LABELS[option]}
              >
                <StatusBadge status={option} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SyncPill state={syncState} />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ReasonDialog
        status={asking}
        onClose={() => setAsking(null)}
        onConfirm={(reason) => {
          const next = asking;
          setAsking(null);
          if (next) apply(next, reason);
        }}
      />
    </div>
  );
}
