import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadTracker } from "@/lib/admin/data";
import { WIZARD_STEPS, type WizardStep } from "@/lib/domain/wizard";
import { firstParam } from "@/lib/url";

import { ActivateStep } from "../../../_parts/steps/activate";
import { ColumnsStep } from "../../../_parts/steps/columns";
import { DetailsStep } from "../../../_parts/steps/details";
import { HeaderStep } from "../../../_parts/steps/header";
import { OwnersStep } from "../../../_parts/steps/owners";
import { PreviewStep } from "../../../_parts/steps/preview";
import { StatusesStep } from "../../../_parts/steps/statuses";
import { WizardFrame } from "../../../_parts/wizard-frame";

export const metadata: Metadata = { title: "Set up a tracker · Knit" };

// PRD 11 steps 3 to 9, for a draft tracker; steps 3 to 8 also edit a live one.
export default async function SetupStepPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; step: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, step } = await params;
  const query = await searchParams;
  const tracker = await loadTracker(id);
  const known = WIZARD_STEPS.find((s) => s.step === step && s.step !== "tab");
  if (!tracker || !known || tracker.state === "archived") notFound();
  if (step === "activate" && tracker.state !== "draft") notFound();
  const current = known.step as Exclude<WizardStep, "tab">;
  // 11.1, N68: the standard setup was just applied. A fixed flag; the words left are worked out
  // from the tab, never read from the URL.
  const standard =
    tracker.state === "draft" && firstParam(query, "standard") === "applied";
  const body = {
    header: <HeaderStep tracker={tracker} />,
    columns: <ColumnsStep tracker={tracker} />,
    statuses: (
      <StatusesStep
        tracker={tracker}
        standard={standard}
        pending={
          // 11: a live tracker's new status columns, saved with this step (saveColumns).
          tracker.state !== "draft" && firstParam(query, "statusRead")
            ? {
                statusRead: firstParam(query, "statusRead") ?? "",
                statusWrite: firstParam(query, "statusWrite") ?? "",
              }
            : null
        }
      />
    ),
    owners: <OwnersStep tracker={tracker} standard={standard} />,
    details: <DetailsStep tracker={tracker} />,
    preview: <PreviewStep tracker={tracker} />,
    activate: <ActivateStep tracker={tracker} />,
  }[current];
  return (
    <WizardFrame tracker={tracker} step={current}>
      {body}
    </WizardFrame>
  );
}
