import { ActionForm } from "@/components/admin/action-form";
import { Field, Section, TextInput } from "@/components/admin/fields";
import { TrackerChip } from "@/components/tracker-chip";
import { saveDetails } from "@/lib/actions/admin";
import { loadSheetDeps, type AdminTracker } from "@/lib/admin/data";
import { goLiveDefault } from "@/lib/domain/wizard";
import { TRACKER_COLORS } from "@/lib/domain/cards";

// PRD 11 step 7: name, colour from the 8-colour palette, go-live (defaults to today; D1).
export async function DetailsStep({ tracker }: { tracker: AdminTracker }) {
  const draft = tracker.state === "draft";
  const today = draft ? await (await loadSheetDeps()).store.today() : null;
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
              draft
                ? "Rows planned before this date are history only; the backlog review can bring them forward."
                : "Fixed once the tracker is live."
            }
          >
            <TextInput
              id="goLive"
              name="goLive"
              type="date"
              defaultValue={
                today === null
                  ? tracker.goLiveDate
                  : goLiveDefault(tracker, today)
              }
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
