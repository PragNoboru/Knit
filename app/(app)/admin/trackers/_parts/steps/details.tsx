import { ActionForm } from "@/components/admin/action-form";
import { Field, Section, TextInput } from "@/components/admin/fields";
import { TrackerChip } from "@/components/tracker-chip";
import { saveDetails } from "@/lib/actions/admin";
import { loadSheetDeps, type AdminTracker } from "@/lib/admin/data";
import { calendarFromDays } from "@/lib/domain/calendar";
import { goLiveDefault } from "@/lib/domain/wizard";
import { TRACKER_COLORS } from "@/lib/domain/cards";

// PRD 11 step 7: name, colour from the 8-colour palette, go-live (defaults to the next working
// day; D1, N42). With no saved date and no calendar day to default to, the date is left empty.
export async function DetailsStep({ tracker }: { tracker: AdminTracker }) {
  const draft = tracker.state === "draft";
  const goLive = await shownGoLive(tracker);
  return (
    <Section title="Name, colour and go-live">
      <ActionForm
        action={saveDetails.bind(null, tracker.id)}
        submitLabel="Save and continue"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <TextInput
              id="name"
              name="name"
              defaultValue={tracker.name}
              maxLength={80}
              required
            />
          </Field>
          <Field
            label="Go-live date"
            htmlFor="goLive"
            hint={
              !draft
                ? "Fixed once the tracker is live."
                : goLive === null
                  ? "The working-day calendar does not reach the next working day yet, so choose a date. Rows due before it are history only."
                  : "Defaults to the next working day. Rows due before this date, today's included, are history only; the backlog review can bring them forward."
            }
          >
            <TextInput
              id="goLive"
              name="goLive"
              type="date"
              defaultValue={goLive ?? ""}
              disabled={!draft}
              required
            />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Colour</legend>
          <div className="flex flex-wrap gap-3">
            {TRACKER_COLORS.map((color) => (
              <label key={color} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="color"
                  value={color}
                  defaultChecked={tracker.color === color}
                  className="size-4 accent-foreground"
                />
                <TrackerChip name={color} color={color} />
              </label>
            ))}
          </div>
        </fieldset>
      </ActionForm>
    </Section>
  );
}

/** The date step 7 shows: the saved one, else the default, which needs today and the calendar. */
async function shownGoLive(tracker: AdminTracker) {
  if (tracker.state !== "draft" || tracker.draft.goLiveChosen)
    return tracker.goLiveDate;
  const { store } = await loadSheetDeps();
  const [today, context] = await Promise.all([
    store.today(),
    store.loadContext(),
  ]);
  return goLiveDefault(tracker, today, calendarFromDays(context.calendar));
}
