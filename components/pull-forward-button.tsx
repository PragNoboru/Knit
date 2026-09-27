"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { pullForward } from "@/lib/actions/tasks";

/** PRD 12.7: "Nothing is planned for today" offers the next tasks with Pull forward (D3). */
export function PullForwardButton({
  taskId,
  title,
}: {
  taskId: string;
  title: string;
}) {
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        aria-label={`Pull forward ${title}`}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await pullForward({
              taskId,
              status: "in_progress",
            });
            if (!result.ok) setError(result.error);
          })
        }
      >
        Pull forward
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
