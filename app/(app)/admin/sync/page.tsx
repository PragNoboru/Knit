import type { Metadata } from "next";

import { ActionButton } from "@/components/admin/action-button";
import { Section, Table } from "@/components/admin/fields";
import { retryWrites } from "@/lib/actions/admin";
import { loadSyncHealth } from "@/lib/admin/data";
import { diffDays, formatDay, formatInstant } from "@/lib/time";

export const metadata: Metadata = { title: "Sync health · Knit" };

const CALENDAR_WARNING_DAYS = 60;

const summarise = (stats: Record<string, unknown> | null) =>
  stats
    ? Object.entries(stats)
        .filter(([, v]) => typeof v === "number" || typeof v === "string")
        .map(([k, v]) => `${k} ${String(v)}`)
        .join(" · ")
    : "";

// PRD 12.8 Sync health: the last 50 runs, write-backs by state with Retry failed, the closes of
// the last 14 days, and how far the calendar reaches.
export default async function SyncHealthPage() {
  const health = await loadSyncHealth();
  const outbox = health.outbox;
  const calendarDaysLeft = health.calendarEnd
    ? diffDays(health.calendarEnd, health.today)
    : null;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Sync health</h1>
      {calendarDaysLeft !== null &&
      calendarDaysLeft <= CALENDAR_WARNING_DAYS ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200"
        >
          The working-day calendar ends on {formatDay(health.calendarEnd!)}.
          Extend it on the Holidays page.
        </p>
      ) : null}

      <Section
        title="Write-backs"
        actions={
          (outbox.failed ?? 0) > 0 ? (
            <ActionButton action={retryWrites.bind(null, null)}>
              Retry failed
            </ActionButton>
          ) : null
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
          {(["pending", "held", "failed", "done", "superseded"] as const).map(
            (state) => (
              <div key={state}>
                <dt className="text-muted-foreground capitalize">{state}</dt>
                <dd className="font-medium tabular-nums">
                  {outbox[state] ?? 0}
                </dd>
              </div>
            ),
          )}
        </dl>
      </Section>

      <Section
        title="Day closes"
        description={`The last 14 days. Calendar covered until ${health.calendarEnd ? formatDay(health.calendarEnd) : "unknown"}.`}
      >
        {health.closures.length === 0 ? (
          <p className="text-sm text-muted-foreground">No closes yet.</p>
        ) : (
          <Table head={["Day", "State", "Closed at", "Counts", "Error"]}>
            {health.closures.map((c) => (
              <tr key={c.day}>
                <td className="whitespace-nowrap">{formatDay(c.day)}</td>
                <td>{c.state}</td>
                <td className="whitespace-nowrap">
                  {c.closedAt ? formatInstant(c.closedAt) : ""}
                </td>
                <td className="max-w-md text-xs whitespace-normal text-muted-foreground">
                  {summarise(c.stats)}
                </td>
                <td className="max-w-xs text-xs whitespace-normal text-destructive">
                  {c.error ?? ""}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Last 50 runs">
        <Table head={["Started", "Job", "Tracker", "Result", "Counts"]}>
          {health.runs.map((run) => (
            <tr key={run.id}>
              <td className="whitespace-nowrap">
                {formatInstant(run.startedAt)}
              </td>
              <td>{run.job}</td>
              <td>{run.tracker ?? ""}</td>
              <td className={run.ok === false ? "text-destructive" : ""}>
                {run.ok === null
                  ? "running"
                  : run.ok
                    ? "ok"
                    : (run.error ?? "failed")}
              </td>
              <td className="max-w-md text-xs whitespace-normal text-muted-foreground">
                {summarise(run.stats)}
              </td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
