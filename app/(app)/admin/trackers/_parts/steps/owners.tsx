import { ActionForm } from "@/components/admin/action-form";
import {
  Field,
  NativeSelect,
  Section,
  TextInput,
} from "@/components/admin/fields";
import { linkOwnerName, saveOwners } from "@/lib/actions/admin";
import {
  loadNormalisedRows,
  loadPeople,
  type AdminTracker,
} from "@/lib/admin/data";
import { unknownOwnerNames } from "@/lib/domain/wizard";

// PRD 11 step 6, 6.7, N1, N3: owner separators, owner filter and off-day policy; owner names
// Knit does not know are linked to a user or marked as non-users here.
export async function OwnersStep({ tracker }: { tracker: AdminTracker }) {
  const [normalised, people] = await Promise.all([
    loadNormalisedRows(tracker),
    loadPeople(),
  ]);
  const unknown = normalised ? unknownOwnerNames(normalised.rows) : [];
  const draft = tracker.draft;

  return (
    <div className="flex flex-col gap-5">
      <Section title="Owners and policies">
        <ActionForm
          action={saveOwners.bind(null, tracker.id)}
          submitLabel="Save and continue"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Owner separators"
              htmlFor="ownerSeparators"
              hint='Separated by spaces. With "," and "+", "P + Agent" is two names.'
            >
              <TextInput
                id="ownerSeparators"
                name="ownerSeparators"
                defaultValue={(draft.ownerSeparators ?? [","]).join(" ")}
              />
            </Field>
            <Field label="Whose rows reach Today" htmlFor="ownerFilter">
              <NativeSelect
                id="ownerFilter"
                name="ownerFilter"
                defaultValue={draft.ownerFilter ?? "mine"}
              >
                <option value="mine">Only rows naming the person</option>
                <option value="all">
                  Every row, also to the tracker owner
                </option>
              </NativeSelect>
            </Field>
            <Field label="Planned on an off day" htmlFor="offDayPolicy">
              <NativeSelect
                id="offDayPolicy"
                name="offDayPolicy"
                defaultValue={draft.offDayPolicy ?? "previous_working_day"}
              >
                <option value="previous_working_day">
                  Due the working day before
                </option>
                <option value="next_working_day">
                  Due the working day after
                </option>
                <option value="keep">Due on the off day itself</option>
              </NativeSelect>
            </Field>
          </div>
        </ActionForm>
      </Section>

      <Section
        title="Owner names Knit does not know"
        description="Link each to a user, or mark it as someone without a Knit login (such as Sales)."
      >
        {!normalised ? (
          <p className="text-sm text-muted-foreground">
            Finish the columns and statuses first.
          </p>
        ) : unknown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Every name is known.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {unknown.map((name) => (
              <li key={name} className="py-2">
                <ActionForm
                  action={linkOwnerName.bind(null, name, null)}
                  submitLabel="Save"
                  submitVariant="outline"
                  className="sm:grid-cols-[10rem_1fr_auto] sm:items-end"
                >
                  <p className="font-medium">{name}</p>
                  <NativeSelect
                    name="user"
                    aria-label={`Who is ${name}`}
                    defaultValue=""
                  >
                    <option value="">Choose</option>
                    {people.users
                      .filter((u) => u.is_active)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    <option value="non_user">Not a Knit user</option>
                  </NativeSelect>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
