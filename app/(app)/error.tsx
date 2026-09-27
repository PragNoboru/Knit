"use client";

import { Button } from "@/components/ui/button";

// PRD 14: when Supabase is unavailable the UI shows an error page with a retry.
export default function AppError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 rounded-xl border bg-card p-6">
      <h1 className="text-lg font-semibold">Knit can&apos;t load this page</h1>
      <p className="text-sm text-muted-foreground">
        The database may be unavailable for a moment. Your work is safe: the
        trackers and the Knit Archive keep everything.
      </p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
