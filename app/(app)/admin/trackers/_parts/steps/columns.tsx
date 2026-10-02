import { ActionForm } from "@/components/admin/action-form";
import {
  Field,
  NativeSelect,
  Section,
  Table,
  TextInput,
} from "@/components/admin/fields";
import { saveColumns } from "@/lib/actions/admin";
import {
  loadSheetDeps,
  loadTabData,
  type AdminTracker,
} from "@/lib/admin/data";
import { normaliseKey } from "@/lib/domain/config";
import {
  CHECKER_HINT,
  CHECKER_LABEL,
  CHECKER_NONE,
  columnSamples,
  DATE_RATE_WARNING,
  dateParseRate,
  END_DATE_HINT,
  endDateParseRate,
  endDateWarning,
  OWNER_HINT,
  OWNER_LABEL,
} from "@/lib/domain/wizard";

// PRD 11 step 4: map the columns. Formula columns are read-only (N6); the date column shows how
// many of its cells Knit can read, with a warning under 90%, and so do the filled End dates read
// with their Date (N64, 6.3.4).
export async function ColumnsStep({ tracker }: { tracker: AdminTracker }) {
  const headerRow = tracker.draft.headerRow;
  if (!headerRow)
    return <p className="text-sm">Choose the header row first.</p>;
  const [{ structure, rows }, today] = await Promise.all([
    loadTabData(tracker.ref, headerRow),
    (await loadSheetDeps()).store.today(),
  ]);
  const formula = new Set(structure.formulaColumns);
  const columns = tracker.draft.columns ?? {};
  const rates = new Map(
    structure.headers.map((h) => [
      h.normalised,
      dateParseRate(rows, h.header, today),
    ]),
  );
  const dateRate = columns.date
    ? rates.get(normaliseKey(columns.date))
    : undefined;
  const endRate =
    columns.date && columns.endDate
      ? endDateParseRate(
          rows,
          { date: columns.date, endDate: columns.endDate },
          today,
        )
      : undefined;
  const headerOptions = (writeTarget: boolean) =>
    structure.headers.map((h) => (
      <option
        key={h.index}
        value={h.header}
        disabled={writeTarget && formula.has(h.normalised)}
      >
        {h.header}
        {formula.has(h.normalised) ? " (formula, read-only)" : ""}
      </option>
    ));
  const select = (
    name: string,
    label: string,
    value: string | null | undefined,
    options: { none?: string; writeTarget?: boolean; hint?: string } = {},
  ) => (
    <Field label={label} htmlFor={name} hint={options.hint}>
      <NativeSelect id={name} name={name} defaultValue={value ?? ""}>
        <option value="">{options.none ?? "Choose a column"}</option>
        {headerOptions(options.writeTarget ?? false)}
      </NativeSelect>
    </Field>
  );
  const format = tracker.draft.completedOnFormat;

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="Columns in this tab"
        description="Sample values from the first rows. Columns whose cells hold formulas are read-only."
      >
        <Table head={["Column", "Samples", "Notes"]}>
          {structure.headers.map((h) => {
            const rate = rates.get(h.normalised);
            return (
              <tr key={h.index}>
                <td className="font-medium">
                  {h.letter} · {h.header}
                </td>
                <td className="max-w-md whitespace-normal text-muted-foreground">
                  {columnSamples(rows, h.header).join(" · ")}
                </td>
                <td className="text-xs text-muted-foreground">
                  {[
                    formula.has(h.normalised) ? "formula, read-only" : null,
                    structure.validations[h.normalised] ? "dropdown" : null,
                    rate && rate.total > 0 && rate.rate >= 0.5
                      ? `${Math.round(rate.rate * 100)}% readable as dates`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            );
          })}
        </Table>
      </Section>

      <Section title="Map the columns">
        {dateRate && dateRate.rate < DATE_RATE_WARNING ? (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
          >
            Only {Math.round(dateRate.rate * 100)}% of the date column can be
            read. Knit cannot read: {dateRate.failing.join(", ")}.
          </p>
        ) : null}
        {endRate && endRate.rate < DATE_RATE_WARNING ? (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
          >
            {endDateWarning(endRate)}
          </p>
        ) : null}
        <ActionForm
          action={saveColumns.bind(null, tracker.id)}
          submitLabel="Save and continue"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {select("date", "Date (planned date)", columns.date)}
            {select("endDate", "End date (optional)", columns.endDate, {
              none: "No end date column",
              hint: END_DATE_HINT,
            })}
            {select("title", "Title", columns.title)}
            {select("statusRead", "Status (read)", columns.statusRead)}
            {select("statusWrite", "Status (write)", columns.statusWrite, {
              none: "Do not write the status",
              writeTarget: true,
              hint: "Where Knit writes status changes. Formula columns cannot be chosen.",
            })}
            {select("completedOn", "Completed on", columns.completedOn, {
              none: "Not written",
              writeTarget: true,
            })}
            <Field label="Completed on format" htmlFor="completedOnFormat">
              <NativeSelect
                id="completedOnFormat"
                name="completedOnFormat"
                defaultValue={format?.type ?? "text"}
              >
                <option value="text">Text</option>
                <option value="date">A real date</option>
              </NativeSelect>
            </Field>
            <Field
              label="Text pattern"
              htmlFor="completedOnPattern"
              hint='For text: "EEE d MMM" writes "Mon 28 Sep".'
            >
              <TextInput
                id="completedOnPattern"
                name="completedOnPattern"
                defaultValue={
                  format?.type === "text" ? format.pattern : "EEE d MMM"
                }
              />
            </Field>
            {select("owner", OWNER_LABEL, columns.owner, {
              none: "No owner column (tasks go to the tracker owner)",
              hint: OWNER_HINT,
            })}
            {select("checker", CHECKER_LABEL, columns.checker, {
              none: CHECKER_NONE,
              hint: CHECKER_HINT,
            })}
            {select("sourceRef", "Source ID", columns.sourceRef, {
              none: "None",
            })}
            {select("critical", "Critical flag", columns.critical?.header, {
              none: "None",
            })}
            <Field
              label="Critical when the cell says"
              htmlFor="criticalTruthy"
              hint="Comma separated, for example: Yes"
            >
              <TextInput
                id="criticalTruthy"
                name="criticalTruthy"
                defaultValue={columns.critical?.truthy.join(", ") ?? ""}
              />
            </Field>
            <Field
              label="Title template (optional)"
              htmlFor="titleTemplate"
              hint="Headers in braces, for example {Asset ID} · {Working title}"
            >
              <TextInput
                id="titleTemplate"
                name="titleTemplate"
                defaultValue={tracker.draft.titleTemplate ?? ""}
              />
            </Field>
            <Field
              label="Subtitle template (optional)"
              htmlFor="subtitleTemplate"
            >
              <TextInput
                id="subtitleTemplate"
                name="subtitleTemplate"
                defaultValue={tracker.draft.subtitleTemplate ?? ""}
              />
            </Field>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">
              Detail columns for the task drawer (up to 8)
            </legend>
            <div className="grid gap-1.5 sm:grid-cols-3">
              {structure.headers.map((h) => (
                <label
                  key={h.index}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    name="details"
                    value={h.header}
                    defaultChecked={tracker.draft.detailColumns?.includes(
                      h.header,
                    )}
                    className="size-4 accent-foreground"
                  />
                  {h.header}
                </label>
              ))}
            </div>
          </fieldset>
        </ActionForm>
      </Section>
    </div>
  );
}
