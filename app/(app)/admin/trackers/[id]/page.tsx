import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ActionButton } from "@/components/admin/action-button";
import { ActionForm } from "@/components/admin/action-form";
import { Section, Table } from "@/components/admin/fields";
import { TrackerChip } from "@/components/tracker-chip";
import { buttonVariants } from "@/components/ui/button";
import {
  archiveTracker,
  pauseTracker,
  recreateKnitIdColumn,
  resumeTracker,
  syncTracker,
} from "@/lib/actions/admin";
import {
  loadAdminTrackers,
  loadSheetDeps,
  loadTracker,
  pausedForMissingKnitIds,
} from "@/lib/admin/data";
import { STATUS_LABELS } from "@/lib/domain/status";
import { previewKnitIdRecreate } from "@/lib/sync/recreate-ids";
import { formatDay, formatInstant } from "@/lib/time";

export const metadata: Metadata = { title: "Tracker · Knit" };

// PRD 12.1, 12.8: a tracker's settings, with Resume, Pause, Sync now, Edit mapping and Archive.
export default async function TrackerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const saved = (await searchParams).saved === "1";
  const tracker = await loadTracker(id);
  if (!tracker) notFound();
  if (tracker.state === "draft") redirect(`/admin/trackers/${id}/setup/header`);
  const summary = (await loadAdminTrackers()).trackers.find((t) => t.id === id);
  const missingIds =
    tracker.state === "paused" && pausedForMissingKnitIds(tracker.pauseReason);
  const { store, source } = await loadSheetDeps();
  const recreate = missingIds
    ? await (async () => {
        const [synced] = await store.trackers({
          states: ["paused"],
          ids: [id],
        });
        return synced ? previewKnitIdRecreate({ store, source }, synced) : null;
      })()
    : null;
  const config = tracker.draft;
  const mapping: [string, string][] = [
    ["Header row", String(config.headerRow ?? "")],
    ["Date", config.columns?.date ?? ""],
    ["Title", config.titleTemplate ?? config.columns?.title ?? ""],
    ["Status (read)", config.columns?.statusRead ?? ""],
    ["Status (write)", config.columns?.statusWrite ?? "Not written"],
    ["Completed on", config.columns?.completedOn ?? "Not written"],
    ["Owner", config.columns?.owner ?? "No owner column"],
    ["Source ID", config.columns?.sourceRef ?? "None"],
    [
      "Critical",
      config.columns?.critical
        ? `${config.columns.critical.header} = ${config.columns.critical.truthy.join(", ")}`
        : "None",
    ],
    ["Details", (config.detailColumns ?? []).join(", ") || "None"],
    ["Read-only", (config.readOnlyColumns ?? []).join(", ") || "None"],
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{tracker.name}</h1>
        <TrackerChip name={tracker.name} color={tracker.color} />
      </div>
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved. Knit checks the tab and pulls it again.
        </p>
      ) : null}

      <Section
        title="State"
        actions={
          <>
            {tracker.state === "active" ? (
              <>
                <ActionButton action={syncTracker.bind(null, id)}>
                  Sync now
                </ActionButton>
                <ActionButton action={pauseTracker.bind(null, id)}>
                  Pause
                </ActionButton>
              </>
            ) : null}
            {tracker.state === "paused" && !missingIds ? (
              <ActionButton action={resumeTracker.bind(null, id)}>
                Resume
              </ActionButton>
            ) : null}
            {tracker.state !== "archived" ? (
              <>
                <Link
                  href={`/admin/trackers/${id}/setup/columns`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Edit mapping
                </Link>
                {/* Glossary, 11 step 2: another tab of this spreadsheet is another tracker. */}
                <Link
                  href={`/admin/trackers/new/${encodeURIComponent(tracker.fileId)}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Set up another tab
                </Link>
                <ActionButton
                  action={archiveTracker.bind(null, id)}
                  confirm="Archive this tracker? Knit stops syncing it; its history stays."
                  variant="destructive"
                >
                  Archive
                </ActionButton>
              </>
            ) : null}
          </>
        }
      >
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">State</dt>
          <dd>
            {tracker.state === "paused"
              ? `Paused: ${tracker.pauseReason ?? ""}`
              : tracker.state === "active"
                ? "Active"
                : "Archived"}
          </dd>
          <dt className="text-muted-foreground">Sheet</dt>
          <dd>
            <a
              className="underline"
              href={`https://docs.google.com/spreadsheets/d/${encodeURIComponent(tracker.fileId)}/edit#gid=${tracker.gid}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {summary?.fileName ?? tracker.fileId} · {tracker.tabName}
            </a>
          </dd>
          <dt className="text-muted-foreground">Go-live</dt>
          <dd>{formatDay(tracker.goLiveDate)}</dd>
          <dt className="text-muted-foreground">Last pull</dt>
          <dd>
            {tracker.lastPullAt ? formatInstant(tracker.lastPullAt) : "Never"}
          </dd>
          <dt className="text-muted-foreground">Tasks</dt>
          <dd>{summary?.taskCount ?? 0}</dd>
          <dt className="text-muted-foreground">Backlog</dt>
          <dd>
            {summary && summary.backlogCount > 0 ? (
              <Link
                href={`/admin/trackers/${id}/backlog`}
                className="underline"
              >
                {summary.backlogCount} open rows before go-live
              </Link>
            ) : (
              "Nothing to review"
            )}
          </dd>
        </dl>
      </Section>

      {recreate ? (
        <Section
          title="Recreate the Knit ID column"
          description="The Knit ID column is gone. Knit can put it back and match rows to tasks by source ID, or else by title and planned date. Check the lists first."
        >
          <div className="grid gap-4 text-sm">
            <p>
              {recreate.matches.length} rows match a task.{" "}
              {recreate.newRows.length} rows match nothing and become new tasks.{" "}
              {recreate.missingTasks.length} tasks match no row and will be
              treated as removed from the sheet.
            </p>
            {recreate.missingTasks.length > 0 ? (
              <details>
                <summary className="cursor-pointer">
                  Tasks with no row ({recreate.missingTasks.length})
                </summary>
                <ul className="mt-2 list-disc pl-5">
                  {recreate.missingTasks.map((t) => (
                    <li key={t.taskId}>{t.title}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {recreate.newRows.length > 0 ? (
              <details>
                <summary className="cursor-pointer">
                  Rows with no task ({recreate.newRows.length})
                </summary>
                <ul className="mt-2 list-disc pl-5">
                  {recreate.newRows.map((r) => (
                    <li key={r.row}>
                      Row {r.row}: {r.title}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <ActionForm
              action={recreateKnitIdColumn.bind(null, id)}
              submitLabel="Recreate and resume"
            />
          </div>
        </Section>
      ) : null}

      <Section title="Mapping">
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {mapping.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-4 mb-2 text-sm font-semibold">Statuses</h3>
        <Table head={["Sheet word", "Knit status"]}>
          {Object.entries(config.statusMap ?? {}).map(([word, status]) => (
            <tr key={word}>
              <td>{word === "" ? "(blank)" : word}</td>
              <td>{STATUS_LABELS[status]}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
