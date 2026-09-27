import Link from "next/link";

import { ActionForm } from "@/components/admin/action-form";
import { Section } from "@/components/admin/fields";
import { activateTracker } from "@/lib/actions/admin";
import { unmappedStatusWords, type AdminTracker } from "@/lib/admin/data";
import { draftProblems, WIZARD_STEPS } from "@/lib/domain/wizard";

// PRD 11 step 9: Knit adds its two columns, writes an ID on every row and runs the first pull.
// Step 5: activation stays blocked while a word of the status column, as the tab holds it now,
// has no Knit status.
export async function ActivateStep({ tracker }: { tracker: AdminTracker }) {
  const problems = draftProblems(tracker.draft, {
    unmappedWords: await unmappedStatusWords(tracker),
  });
  const titleOf = (step: string) =>
    WIZARD_STEPS.find((s) => s.step === step)?.title ?? step;
  return (
    <Section
      title="Activate"
      description="Knit adds a hidden Knit ID column and a visible Knit Note column after the last used column, protects the Knit ID column with a warning, writes an ID on every row and runs the first pull. It never changes your other columns."
    >
      {problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {problems.map((p) => (
            <li key={p.problem}>
              {p.problem}{" "}
              <Link
                href={`/admin/trackers/${tracker.id}/setup/${p.step}`}
                className="underline"
              >
                {titleOf(p.step)}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <ActionForm
          action={activateTracker.bind(null, tracker.id)}
          submitLabel="Activate"
        />
      )}
    </Section>
  );
}
