import { ActionForm } from "@/components/admin/action-form";
import { Section } from "@/components/admin/fields";
import { saveHeaderRow } from "@/lib/actions/admin";
import {
  loadSheetDeps,
  loadTopRows,
  type AdminTracker,
} from "@/lib/admin/data";
import { suggestHeaderRow } from "@/lib/domain/wizard";

// PRD 11 step 3: the first 10 rows; the first mostly-text row is suggested; the admin confirms.
export async function HeaderStep({ tracker }: { tracker: AdminTracker }) {
  const [rows, today] = await Promise.all([
    loadTopRows(tracker.ref),
    (await loadSheetDeps()).store.today(),
  ]);
  const suggested = suggestHeaderRow(rows, today);
  const chosen = tracker.draft.headerRow ?? suggested;
  const width = Math.min(8, Math.max(1, ...rows.map((r) => r.length)));

  return (
    <Section
      title="Which row holds the column names?"
      description={`Knit suggests row ${suggested}.`}
    >
      <ActionForm
        action={saveHeaderRow.bind(null, tracker.id)}
        submitLabel="Save and continue"
      >
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-max text-sm">
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-b">
                  <td className="py-1.5 pr-3">
                    <label className="flex items-center gap-2 whitespace-nowrap">
                      <input
                        type="radio"
                        name="headerRow"
                        value={index + 1}
                        defaultChecked={index + 1 === chosen}
                        className="size-4 accent-foreground"
                      />
                      Row {index + 1}
                    </label>
                  </td>
                  {Array.from({ length: width }, (_, c) => (
                    <td
                      key={c}
                      className="max-w-40 truncate py-1.5 pr-3 text-muted-foreground"
                    >
                      {row[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ActionForm>
    </Section>
  );
}
