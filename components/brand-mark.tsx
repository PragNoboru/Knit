import { cn } from "@/lib/utils";

/**
 * PRD 12.2: the Noboru mark, a lime and a dark triangle, beside the Knit wordmark.
 * The dark triangle takes the text colour, so it turns light in dark mode.
 * Decorative: the wordmark beside it carries the name. Size it with className.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 136"
      aria-hidden
      focusable="false"
      className={cn("aspect-[100/136] h-5 w-auto shrink-0", className)}
    >
      <polygon points="0,0 94,0 94,107" fill="#77cb35" />
      <polygon points="6,30 6,136 100,136" fill="currentColor" />
    </svg>
  );
}
