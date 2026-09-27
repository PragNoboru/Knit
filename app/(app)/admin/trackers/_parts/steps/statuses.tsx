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
  statusChoices,
  statusField,
  writeBackField,
  writeBackWords,
} from "@/lib/domain/wizard";

// PRD 11 step 5, 6.8: every word of the status column's dropdown and every word found, each
// mapped to a Knit status; then the word Knit writes back for each Knit status (or leave the
// cell unchanged, N8, or clear it). Activation stays blocked while a word is unmapped.
export async function StatusesStep({ tracker }: { tracker: AdminTracker }) {
  const { headerRow, columns } = tracker.draft;
  const statusHeader = columns?.statusRead;
  if (!headerRow || !statusHeader)
    return <p className="text-sm">Map the columns first.</p>;
  const { structure, rows } = await loadTabData(tracker.ref, headerRow);
  const validation = structure.validations[normaliseKey(statusHeader)];
  const choices = statusChoices(
    rows,
    statusHeader,
    validation?.options ?? null,
  );
  const words = writeBackWords(choices);
  const map = tracker.draft.statusMap ?? {};
  const writeBack = tracker.draft.writeBack ?? {};
  const canWrite = Boolean(columns?.statusWrite);
  const writeDefault = (status: (typeof USER_STATUSES)[number]) => {
    const value = writeBack[status];
    if (value === undefined) return canWrite ? "" : LEAVE_UNCHANGED;
    return value === null ? LEAVE_UNCHANGED : value === "" ? CLEAR_CELL : value;
  };

  return (
    <ActionForm
      action={saveStatuses.bind(null, tracker.id)}
      submitLabel="Save and continue"
    >
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
            ? `The word Knit writes to "${columns?.statusWrite}" for each Knit status.`
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
                {canWrite
                  ? words.map((word) => (
                      <option key={word} value={word}>
                        {word}
                      </option>
                    ))
                  : null}
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
