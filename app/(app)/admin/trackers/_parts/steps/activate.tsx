import Link from "next/link";

import { ActionForm } from "@/components/admin/action-form";
import { Section } from "@/components/admin/fields";
import { activateTracker } from "@/lib/actions/admin";
import {
  currentGoLive,
  unmappedStatusWords,
  type AdminTracker,
} from "@/lib/admin/data";
import {
  draftProblems,
  GO_LIVE_NEEDS_A_DATE,
  WIZARD_STEPS,
} from "@/lib/domain/wizard";

// PRD 11 step 9: Knit adds its two columns, writes an ID on every row and runs the first pull.
// Step 5: activation stays blocked while a word of the status column, as the tab holds it now,
// has no Knit status. Step 7 (N42): with no saved go-live and no calendar day to default to,
// the admin is sent back to choose a date, as activateTracker would refuse.
export async function ActivateStep({ tracker }: { tracker: AdminTracker }) {
  const [unmappedWords, goLive] = await Promise.all([
    unmappedStatusWords(tracker),
    currentGoLive(tracker),
  ]);
  const problems = draftProblems(tracker.draft, { unmappedWords });
  if (goLive === null)
    problems.push({ step: "details", problem: GO_LIVE_NEEDS_A_DATE });
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
