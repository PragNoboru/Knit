import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/admin/action-form";
import { Section } from "@/components/admin/fields";
import { startSetup } from "@/lib/actions/admin";
import { loadAdminTrackers, loadSheetDeps } from "@/lib/admin/data";

import { WizardFrame } from "../../_parts/wizard-frame";

export const metadata: Metadata = { title: "Set up a tracker · Knit" };

// PRD 11 step 2: tabs are listed by title and stored by sheetId; a connected tab says so.
export default async function PickTabPage({
  params,
}: {
  params: Promise<{ fileId: string }>;
}) {
  const fileId = decodeURIComponent((await params).fileId);
  const { trackers, files } = await loadAdminTrackers();
  const file = files.find((f) => f.fileId === fileId);
  const known = file ?? trackers.find((t) => t.fileId === fileId);
  if (!known) notFound();
  const { source } = await loadSheetDeps();
  const tabs = await source.listTabs(fileId);
  const name =
    file?.name ?? trackers.find((t) => t.fileId === fileId)?.fileName;

  return (
    <WizardFrame tracker={null} step="tab">
      <Section
        title={`Pick a tab of ${name ?? "this sheet"}`}
        description="Each tab can be one tracker. Renaming the tab later does not matter."
      >
        <ul className="flex flex-col divide-y">
          {tabs.map((tab) => {
            const connected = trackers.find(
              (t) =>
                t.fileId === fileId &&
                t.gid === tab.sheetId &&
                t.state !== "archived",
            );
            return (
              <li
                key={tab.sheetId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <p className="font-medium">{tab.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {tab.rowCount} rows · {tab.columnCount} columns
                  </p>
                </div>
                {connected ? (
                  <Link
                    href={`/admin/trackers/${connected.id}`}
                    className="text-sm underline"
                  >
                    Connected as {connected.name}
                  </Link>
                ) : (
                  <ActionForm
                    action={startSetup.bind(null, fileId, tab.sheetId)}
                    submitLabel="Use this tab"
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Section>
    </WizardFrame>
  );
}
