import { closeRunSummary, recordedRun, runJob } from "@/lib/jobs/cron";
import { closeDays } from "@/lib/sync/close";

// PRD 7.3, 10.5: close every unclosed day before today, oldest first. Every 15 minutes; a
// no-op once all days are closed. A call that closed a day or failed is a sync_runs row (19).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The plan's allowed maximum (7.3): see docs/RUNBOOK.md 2.3 before changing it.
export const maxDuration = 60;

export async function POST(request: Request) {
  return runJob(
    request,
    "close",
    maxDuration,
    async ({ store, source, archive, deadline }) => ({
      ...(await recordedRun(
        store,
        "close",
        () => closeDays({ store, source, archive }, { deadline }),
        closeRunSummary,
      )),
    }),
  );
}
