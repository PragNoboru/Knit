import { cn } from "@/lib/utils";
import type { TrackerColor } from "@/lib/domain/cards";

// PRD 12.2: one colour per tracker, always with the tracker's name as text.
const CHIP: Record<TrackerColor, string> = {
  indigo: "bg-tracker-indigo/12 text-tracker-indigo",
  teal: "bg-tracker-teal/12 text-tracker-teal",
  amber: "bg-tracker-amber/12 text-tracker-amber",
  rose: "bg-tracker-rose/12 text-tracker-rose",
  violet: "bg-tracker-violet/12 text-tracker-violet",
  emerald: "bg-tracker-emerald/12 text-tracker-emerald",
  sky: "bg-tracker-sky/12 text-tracker-sky",
  orange: "bg-tracker-orange/12 text-tracker-orange",
};

const DOT: Record<TrackerColor, string> = {
  indigo: "bg-tracker-indigo",
  teal: "bg-tracker-teal",
  amber: "bg-tracker-amber",
  rose: "bg-tracker-rose",
  violet: "bg-tracker-violet",
  emerald: "bg-tracker-emerald",
  sky: "bg-tracker-sky",
  orange: "bg-tracker-orange",
};

export function TrackerChip({
  name,
  color,
  className,
}: {
  name: string;
  color: TrackerColor;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        CHIP[color],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", DOT[color])}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}
