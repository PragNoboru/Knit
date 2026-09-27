import type { Metadata } from "next";

import { ActionButton } from "@/components/admin/action-button";
import { Section, Table } from "@/components/admin/fields";
import { HolidayForm } from "@/components/admin/holiday-form";
import { addHoliday, extendCalendar, removeHoliday } from "@/lib/actions/admin";
import { loadHolidays } from "@/lib/admin/data";
import { formatDate, formatDay } from "@/lib/time";

export const metadata: Metadata = { title: "Holidays · Knit" };

// PRD 12.8 Holidays: list, add, remove. Saving refreshes the working-day calendar; open
// task-days get their due dates recomputed, closed days never change (6.2, 6.4).
export default async function HolidaysPage() {
  const { holidays, calendarEnd } = await loadHolidays();

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Holidays</h1>

      <Section
        title="Add a holiday"
        description="Open tasks due on or planned for that date get a new due date. Closed days do not change."
      >
        <HolidayForm action={addHoliday} />
      </Section>

      <Section
        title="Working-day calendar"
        description={
          calendarEnd
            ? `Covers every day until ${formatDate(calendarEnd, "EEE d MMM yyyy")}.`
            : "Not built yet."
        }
        actions={
          calendarEnd ? (
            <ActionButton action={extendCalendar.bind(null, calendarEnd)}>
              Extend by a year
            </ActionButton>
          ) : null
        }
      >
        <Table head={["Date", "Holiday", ""]}>
          {holidays.map((holiday) => (
            <tr key={holiday.day}>
              <td className="whitespace-nowrap">
                {formatDay(holiday.day)} {holiday.day.slice(0, 4)}
              </td>
              <td>{holiday.name}</td>
              <td>
                <ActionButton
                  action={removeHoliday.bind(null, holiday.day)}
                  confirm={`Remove ${holiday.name}? Open tasks get new due dates; closed days do not change.`}
                  variant="ghost"
                >
                  Remove
                </ActionButton>
              </td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
