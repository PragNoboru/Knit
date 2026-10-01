import { ActionForm } from "@/components/admin/action-form";
import {
  Field,
  NativeSelect,
  Section,
  Table,
  TextInput,
} from "@/components/admin/fields";
import { saveStatuses } from "@/lib/actions/admin";
import { loadTabData, type AdminTracker } from "@/lib/admin/data";
import { normaliseKey, USER_STATUSES } from "@/lib/domain/config";
import { STATUS_LABELS } from "@/lib/domain/status";
import {
  CLEAR_CELL,
  LEAVE_UNCHANGED,
  STATUSES_LIVE_HINT,
  statusChoices,
  statusField,
  writeBackField,
  writeBackOptions,
} from "@/lib/domain/wizard";

// PRD 11 step 5, 6.8: every word of the status column's dropdown and every word found, each
// mapped to a Knit status; then the word Knit writes back for each Knit status (or leave the
// cell unchanged, N8, or clear it), chosen from the words of the status write column.
// Activation stays blocked while a word is unmapped. On a live tracker whose status columns
// were just changed (`pending`), the new columns are mapped here and saved with this step.
export async function StatusesStep({
  tracker,
  pending = null,
}: {
  tracker: AdminTracker;
  pending?: { statusRead: string; statusWrite: string } | null;
}) {
  const { headerRow, columns } = tracker.draft;
  if (!headerRow || !columns?.statusRead)
    return <p className="text-sm">Map the columns first.</p>;
  const { structure, rows } = await loadTabData(tracker.ref, headerRow);
  const headerOf = (value: string) =>
    structure.headers.find((h) => h.normalised === normaliseKey(value))
      ?.header ?? null;
  const newRead = pending ? headerOf(pending.statusRead) : null;
  const newWrite =
    pending && pending.statusWrite !== ""
      ? headerOf(pending.statusWrite)
      : null;
  const next =
    newRead !== null && (pending?.statusWrite === "" || newWrite !== null)
      ? { read: newRead, write: newWrite }
      : null;
  const switching = next !== null;
  const statusHeader = next ? next.read : columns.statusRead;
  const writeHeader = next ? next.write : (columns.statusWrite ?? null);
  const dropdown = (header: string) =>
    structure.validations[normaliseKey(header)]?.options ?? null;
  const validation = structure.validations[normaliseKey(statusHeader)];
  const choices = statusChoices(rows, statusHeader, dropdown(statusHeader));
  const words = writeBackOptions(
    rows,
    writeHeader,
    writeHeader ? dropdown(writeHeader) : null,
  );
  const map = tracker.draft.statusMap ?? {};
  const writeBack = tracker.draft.writeBack ?? {};
  const canWrite = writeHeader !== null;
  const writeDefault = (status: (typeof USER_STATUSES)[number]) => {
    const value = writeBack[status];
    if (value === undefined) return canWrite ? "" : LEAVE_UNCHANGED;
    if (value === null) return LEAVE_UNCHANGED;
    if (value === "") return canWrite ? CLEAR_CELL : LEAVE_UNCHANGED;
    return words.includes(value) ? value : "";
  };

  return (
    <ActionForm
      action={saveStatuses.bind(null, tracker.id)}
      submitLabel="Save and continue"
    >
      {switching ? (
        <>
          <p role="status" className="text-sm">
            The status columns change to &quot;{statusHeader}&quot; (read) and{" "}
            {writeHeader ? `"${writeHeader}"` : "none"} (write) when you save
            this step. Until then Knit keeps using the current ones.
          </p>
          <input type="hidden" name="pendingStatusRead" value={statusHeader} />
          <input
            type="hidden"
            name="pendingStatusWrite"
            value={writeHeader ?? ""}
          />
        </>
      ) : null}
      {tracker.state !== "draft" && !switching ? (
        // PRD 11, N28: a remap reaches only new rows and rows that change to the word.
        <p className="text-sm text-muted-foreground">{STATUSES_LIVE_HINT}</p>
      ) : null}
      <Section
        title={`Words in "${statusHeader}"`}
        description={
          validation && validation.options === null
            ? `The dropdown's list (${validation.source}) could not be read, so only the words in use are listed.`
            : "Every word of the dropdown and every word in use."
        }
      >
        <Table head={["Word", "Rows", "Knit status", "Reason when cancelled"]}>
          {choices.map((choice) => (
            <tr key={choice.key}>
              <td className="font-medium">
                {choice.word === "" ? "(blank)" : choice.word}
                {choice.inDropdown ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    in dropdown
                  </span>
                ) : null}
              </td>
              <td className="tabular-nums">{choice.count}</td>
              <td>
                <NativeSelect
                  name={statusField(choice.key)}
                  aria-label={`Knit status for ${choice.word || "blank"}`}
                  defaultValue={map[choice.key] ?? ""}
                  className="w-40"
                >
                  <option value="">Choose</option>
                  {USER_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </NativeSelect>
              </td>
              <td>
                <TextInput
                  name={`cancelReason:${choice.key}`}
                  aria-label={`Reason when ${choice.word || "blank"} means cancelled`}
                  defaultValue={tracker.draft.cancelReasons?.[choice.key] ?? ""}
                  placeholder="Optional"
                  className="w-48"
                />
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title="What Knit writes back"
        description={
          canWrite
            ? `The word Knit writes to "${writeHeader}" for each Knit status, from that column's dropdown or the words in it.`
            : "No status write column is mapped: Knit leaves the sheet's statuses alone."
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {USER_STATUSES.map((status) => (
            <Field
              key={status}
              label={STATUS_LABELS[status]}
              htmlFor={writeBackField(status)}
            >
              <NativeSelect
                id={writeBackField(status)}
                name={writeBackField(status)}
                defaultValue={writeDefault(status)}
              >
                <option value="">Choose</option>
                {words.map((word) => (
                  <option key={word} value={word}>
                    {word}
                  </option>
                ))}
                <option value={LEAVE_UNCHANGED}>Leave unchanged</option>
                {canWrite ? (
                  <option value={CLEAR_CELL}>Clear the cell</option>
                ) : null}
              </NativeSelect>
            </Field>
          ))}
        </div>
      </Section>
    </ActionForm>
  );
}
