import Link from "next/link";

import { Section, Table } from "@/components/admin/fields";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { loadNormalisedRows, type AdminTracker } from "@/lib/admin/data";
import { GO_LIVE_NEEDS_A_DATE, previewStats } from "@/lib/domain/wizard";
import { formatDay } from "@/lib/time";

// PRD 11 step 8: the first 20 tasks as Today would show them, and the counts. Nothing is written.
// It uses the go-live activation would use: the saved date, else the next working day (N42).
export async function PreviewStep({ tracker }: { tracker: AdminTracker }) {
  const normalised = await loadNormalisedRows(tracker);
  if (!normalised)
    return (
      <p className="text-sm">
        Finish the columns and statuses first; the preview needs them.
      </p>
    );
  const { goLive } = normalised;
  if (goLive === null) return <p className="text-sm">{GO_LIVE_NEEDS_A_DATE}</p>;
  const stats = previewStats(normalised.rows, goLive);
  const upcoming = normalised.rows
    .filter(
      (row) =>
        (row.dueDate !== null && row.dueDate >= goLive) ||
        row.date.kind === "open",
    )
    .sort((a, b) => ((a.dueDate ?? "9999") < (b.dueDate ?? "9999") ? -1 : 1))
    .slice(0, 20);
  const counts: [string, number | string][] = [
    ["Tasks", stats.tasks],
    ["Assigned to someone", stats.mine],
    ["Single dates", stats.byKind.single],
    ["Date ranges", stats.byKind.window],
    ["Open-ended", stats.byKind.open],
    ["Moved off an off day", stats.offDayMoves],
    ["Dates Knit cannot read", stats.invalidDates],
    ["Before go-live (history only)", stats.historyOnly],
    [
      "Unmapped statuses",
      stats.unmappedStatuses.length === 0
        ? "None"
        : stats.unmappedStatuses.join(", "),
    ],
  ];

  return (
    <div className="flex flex-col gap-5">
      <Section title="Counts">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {counts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="First 20 tasks">
        <Table head={["Due", "Title", "Status", "Owner"]}>
          {upcoming.map((row) => (
            <tr key={row.rowNumber}>
              <td className="whitespace-nowrap">
                {row.dueDate
                  ? formatDay(row.dueDate)
                  : row.date.kind === "open"
                    ? `From ${formatDay(row.date.start)}`
                    : ""}
              </td>
              <td className="max-w-md whitespace-normal">
                {row.critical ? "Critical · " : ""}
                {row.title}
              </td>
              <td>
                <StatusBadge status={row.status.status} />
              </td>
              <td className="text-muted-foreground">{row.ownerRaw ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Section>
      {tracker.state === "draft" ? (
        <div>
          <Link
            href={`/admin/trackers/${tracker.id}/setup/activate`}
            className={buttonVariants()}
          >
            Continue to activation
          </Link>
        </div>
      ) : null}
    </div>
  );
}
