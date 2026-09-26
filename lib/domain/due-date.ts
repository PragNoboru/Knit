import type { LocalDate } from "@/lib/time";

import type { WorkingCalendar } from "./calendar";
import type { OffDayPolicy } from "./config";
import type { ParsedDate } from "./dates";

/**
 * PRD 6.3.3, N1: the date a task is due in Knit. A single date is due on its day if that is a
 * working day, otherwise on the previous working day (default), the next one, or the day itself
 * (`keep`). A window is due on its last day, adjusted the same way. Open-ended tasks have no
 * due date.
 */
export function dueDateFor(
  parsed: ParsedDate,
  policy: OffDayPolicy,
  calendar: WorkingCalendar,
): LocalDate | null {
  const planned =
    parsed.kind === "single"
      ? parsed.start
      : parsed.kind === "window"
        ? parsed.end
        : null;
  if (planned === null) return null;
  if (policy === "keep" || calendar.isWorkingDay(planned)) return planned;
  return policy === "previous_working_day"
    ? calendar.prevWorkingDay(planned)
    : calendar.nextWorkingDay(planned);
}

/** The planned date that the due date was derived from (single date or window end). */
export function plannedDueSource(parsed: ParsedDate): LocalDate | null {
  if (parsed.kind === "single") return parsed.start;
  if (parsed.kind === "window") return parsed.end;
  return null;
}
