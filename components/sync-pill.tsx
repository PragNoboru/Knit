import { LoaderCircle, TriangleAlert } from "lucide-react";

import type { SyncState } from "@/lib/domain/cards";

// PRD 12.3: "Syncing" until the write-back is in the sheet; amber "Not saved to sheet" after it
// failed.
export function SyncPill({ state }: { state: SyncState }) {
  if (state === null) return null;
  if (state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800 dark:bg-amber-400/15 dark:text-amber-300">
        <TriangleAlert aria-hidden className="size-3" />
        Not saved to sheet
      </span>
    );
  }
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
    >
      <LoaderCircle aria-hidden className="size-3 animate-spin" />
      Syncing
    </span>
  );
}
