import type { Metadata } from "next";
import Link from "next/link";

import { ActionButton } from "@/components/admin/action-button";
import { Section, Table } from "@/components/admin/fields";
import { TrackerChip } from "@/components/tracker-chip";
import { buttonVariants } from "@/components/ui/button";
import {
  pauseTracker,
  resumeTracker,
  setFileIgnored,
  syncTracker,
} from "@/lib/actions/admin";
import { loadAdminTrackers, pausedForMissingKnitIds } from "@/lib/admin/data";
import { formatInstant } from "@/lib/time";

export const metadata: Metadata = { title: "Trackers · Knit" };

// PRD 7.4, 14: how a file that is not a Google Sheet is shown.
const NOT_A_SHEET =
  "Not a Google Sheet: open it and use File > Save as Google Sheets";

const STATE_LABELS = {
  draft: "Being set up",
  active: "Active",
  paused: "Paused",
  disconnected: "Disconnected",
  archived: "Archived",
} as const;

// PRD 12.8 Trackers: state, last pull, task count, open attention count; New sheet found.
export default async function TrackersPage() {
  const { trackers, files } = await loadAdminTrackers();
  const newFiles = files.filter(
    (f) => f.state === "new" || (f.state === "connected" && f.trackers === 0),
  );
  const ignored = files.filter((f) => f.state === "ignored");
  const notSheets = files.filter((f) => f.state === "not_a_sheet");
  // Glossary, 11 step 2: a spreadsheet with two task tabs is two trackers, so each sheet
  // that already has one offers its other tabs (once per sheet, on its first row).
  const firstRowOfFile = new Set(
    trackers
      .filter((t) => t.state !== "archived")
      .filter(
        (t, index, all) =>
          all.findIndex((o) => o.fileId === t.fileId) === index,
      )
      .map((t) => t.id),
  );

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Trackers</h1>
      <Section
        title="New sheet found"
        description="Google Sheets in the Knit folder that are not trackers yet. Sync now looks for new ones."
      >
        {newFiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No new sheets.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {newFiles.map((file) => (
              <li
                key={file.fileId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <div>
                  <p className="font-medium">{file.name}</p>
                  {file.modifiedTime ? (
                    <p className="text-xs text-muted-foreground">
                      Changed {formatInstant(file.modifiedTime)}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/admin/trackers/new/${encodeURIComponent(file.fileId)}`}
                    className={buttonVariants({ size: "sm" })}
                  >
                    Set up
                  </Link>
                  <ActionButton
                    action={setFileIgnored.bind(null, file.fileId, true)}
                  >
                    Ignore
                  </ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Connected trackers">
        {trackers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Connect your first tracker.
          </p>
        ) : (
          <Table
            head={[
              "Tracker",
              "State",
              "Last pull",
              "Tasks",
              "Needs attention",
              "",
            ]}
          >
            {trackers.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link
                    href={
                      t.state === "draft"
                        ? `/admin/trackers/${t.id}/setup/header`
                        : `/admin/trackers/${t.id}`
                    }
                    className="hover:underline"
                  >
                    <TrackerChip name={t.name} color={t.color} />
                  </Link>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.fileName} · {t.tabName}
                  </p>
                  {firstRowOfFile.has(t.id) ? (
                    <Link
                      href={`/admin/trackers/new/${encodeURIComponent(t.fileId)}`}
                      className="mt-1 inline-block text-xs underline"
                    >
                      Set up another tab
                    </Link>
                  ) : null}
                </td>
                <td>
                  {STATE_LABELS[t.state]}
                  {t.pauseReason ? (
                    <p className="max-w-64 text-xs whitespace-normal text-muted-foreground">
                      {t.pauseReason}
                    </p>
                  ) : null}
                </td>
                <td>{t.lastPullAt ? formatInstant(t.lastPullAt) : "Never"}</td>
                <td className="tabular-nums">{t.taskCount}</td>
                <td className="tabular-nums">
                  {t.openAttention > 0 ? (
                    <Link href="/admin/attention" className="underline">
                      {t.openAttention}
                    </Link>
                  ) : (
                    0
                  )}
                </td>
                <td>
                  <div className="flex gap-2">
                    {t.state === "active" ? (
                      <>
                        <ActionButton action={syncTracker.bind(null, t.id)}>
                          Sync now
                        </ActionButton>
                        <ActionButton action={pauseTracker.bind(null, t.id)}>
                          Pause
                        </ActionButton>
                      </>
                    ) : null}
                    {t.state === "paused" &&
                    pausedForMissingKnitIds(t.pauseReason) ? (
                      // 14: the Knit ID column is recreated only after the admin checks the
                      // preview on the tracker's page.
                      <Link
                        href={`/admin/trackers/${t.id}`}
                        className={buttonVariants({
                          size: "sm",
                          variant: "outline",
                        })}
                      >
                        Recreate Knit IDs
                      </Link>
                    ) : t.state === "paused" ? (
                      <ActionButton action={resumeTracker.bind(null, t.id)}>
                        Resume
                      </ActionButton>
                    ) : null}
                    {t.state === "draft" ? (
                      <Link
                        href={`/admin/trackers/${t.id}/setup/header`}
                        className={buttonVariants({
                          size: "sm",
                          variant: "outline",
                        })}
                      >
                        Continue setup
                      </Link>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {ignored.length > 0 ? (
        <Section title="Ignored sheets">
          <ul className="flex flex-col divide-y">
            {ignored.map((file) => (
              <li
                key={file.fileId}
                className="flex items-center justify-between gap-2 py-2"
              >
                <span>{file.name}</span>
                <ActionButton
                  action={setFileIgnored.bind(null, file.fileId, false)}
                >
                  List again
                </ActionButton>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {notSheets.length > 0 ? (
        <Section
          title="Not Google Sheets"
          description="Files in the Knit folder that Knit never syncs."
        >
          <ul className="list-disc pl-5 text-sm">
            {notSheets.map((file) => (
              <li key={file.fileId}>
                {file.name}: {NOT_A_SHEET}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
