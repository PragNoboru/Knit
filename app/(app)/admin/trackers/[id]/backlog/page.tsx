import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/admin/action-form";
import {
  Field,
  NativeSelect,
  Section,
  TextInput,
} from "@/components/admin/fields";
import { StatusBadge } from "@/components/status-badge";
import { TrackerChip } from "@/components/tracker-chip";
import { backlogAction } from "@/lib/actions/admin";
import { loadBacklog, loadSheetDeps, loadTracker } from "@/lib/admin/data";
import { backlogReviewHint } from "@/lib/domain/backlog";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";
import { formatDay, type LocalDate } from "@/lib/time";

export const metadata: Metadata = { title: "Backlog review · Knit" };

// PRD 6.11, 11 step 10: open rows planned before go-live. Bring to today, Mark done, or Cancel
// (reason required); rows left alone stay history only. Bring to today puts tasks on the first
// working day on or after the later of today and go-live (N61); when that is not today, the page
// names the day.
export default async function BacklogPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const tracker = await loadTracker(id);
  if (!tracker || tracker.state === "draft") notFound();
  const rows = await loadBacklog(id);
  const hint = rows.length === 0 ? null : await backlogHint(tracker.goLiveDate);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Backlog review</h1>
        <TrackerChip name={tracker.name} color={tracker.color} />
      </div>
      <p className="text-sm text-muted-foreground">
        Rows planned before go-live ({formatDay(tracker.goLiveDate)}) that the
        sheet still has open. Rows you leave alone stay history only.{" "}
        <Link href={`/admin/trackers/${id}`} className="underline">
          Back to the tracker
        </Link>
      </p>
      {rows.length === 0 ? (
        <Section title="Nothing to review">
          <p className="text-sm text-muted-foreground">
            Every old row is done, cancelled or already brought forward.
          </p>
        </Section>
      ) : (
        <Section title={`${rows.length} open rows`}>
          <ActionForm action={backlogAction} submitLabel="Apply to selected">
            <ul className="flex flex-col divide-y">
              {rows.map((card) => (
                <li key={card.taskId} className="py-2">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      name="taskId"
                      value={card.taskId}
                      className="mt-1 size-4 accent-foreground"
                    />
                    <span className="grid gap-0.5">
                      <span className="font-medium">{card.title}</span>
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {card.dueDate ? `Due ${formatDay(card.dueDate)}` : ""}
                        <StatusBadge status={card.taskStatus} />
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Action" htmlFor="action" hint={hint}>
                <NativeSelect
                  id="action"
                  name="action"
                  defaultValue="bring_to_today"
                >
                  <option value="bring_to_today">Bring to today</option>
                  <option value="mark_done">Mark done</option>
                  <option value="cancel">Cancel</option>
                </NativeSelect>
              </Field>
              <Field label="Reason (needed to cancel)" htmlFor="reason">
                <TextInput
                  id="reason"
                  name="reason"
                  maxLength={REASON_MAX_LENGTH}
                />
              </Field>
            </div>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}

/** N61: where Bring to today puts tasks, read from today and the working-day calendar. */
async function backlogHint(goLiveDate: LocalDate): Promise<string | null> {
  const { store } = await loadSheetDeps();
  const [today, context] = await Promise.all([
    store.today(),
    store.loadContext(),
  ]);
  return backlogReviewHint(goLiveDate, today, context.calendar);
}
