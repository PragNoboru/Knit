import Link from "next/link";

import { TrackerChip } from "@/components/tracker-chip";
import type { AdminTracker } from "@/lib/admin/data";
import { WIZARD_STEPS, type WizardStep } from "@/lib/domain/wizard";
import { cn } from "@/lib/utils";

/** PRD 11: the wizard's steps, with the current one marked. Editing a live tracker (11,
 * "Editing a live tracker's mapping") uses the same screens without activation. */
export function WizardFrame({
  tracker,
  step,
  children,
}: {
  tracker: AdminTracker | null;
  step: WizardStep;
  children: React.ReactNode;
}) {
  const editing = tracker !== null && tracker.state !== "draft";
  const steps = WIZARD_STEPS.filter(
    (s) => !editing || (s.step !== "tab" && s.step !== "activate"),
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {editing ? "Edit mapping" : "Set up a tracker"}
        </h1>
        {tracker ? (
          <TrackerChip name={tracker.name} color={tracker.color} />
        ) : null}
      </div>
      <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="Steps">
        {steps.map((s, index) => {
          const current = s.step === step;
          const reachable = tracker !== null && s.step !== "tab";
          const label = `${editing ? index + 1 : index + 2}. ${s.title}`;
          return (
            <li key={s.step}>
              {reachable && !current ? (
                <Link
                  href={`/admin/trackers/${tracker.id}/setup/${s.step}`}
                  className="inline-block rounded-full border px-2.5 py-1 text-muted-foreground hover:bg-muted"
                >
                  {label}
                </Link>
              ) : (
                <span
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "inline-block rounded-full border px-2.5 py-1",
                    current
                      ? "border-foreground bg-foreground text-background"
                      : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {children}
    </div>
  );
}
