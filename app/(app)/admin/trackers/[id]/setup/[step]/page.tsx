import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadTracker } from "@/lib/admin/data";
import { WIZARD_STEPS, type WizardStep } from "@/lib/domain/wizard";

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
}: {
  params: Promise<{ id: string; step: string }>;
}) {
  const { id, step } = await params;
  const tracker = await loadTracker(id);
  const known = WIZARD_STEPS.find((s) => s.step === step && s.step !== "tab");
  if (!tracker || !known || tracker.state === "archived") notFound();
  if (step === "activate" && tracker.state !== "draft") notFound();
  const current = known.step as Exclude<WizardStep, "tab">;
  const body = {
    header: <HeaderStep tracker={tracker} />,
    columns: <ColumnsStep tracker={tracker} />,
    statuses: <StatusesStep tracker={tracker} />,
    owners: <OwnersStep tracker={tracker} />,
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
