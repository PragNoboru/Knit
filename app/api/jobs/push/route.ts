import { pushRunSummary, recordedRun, runJob } from "@/lib/jobs/cron";
import { pushDue } from "@/lib/sync/push";

// PRD 7.3, 10.4: write-backs, every minute. The immediate push after a status change is the
// fast path; this is the retry path. A call that pushed something is a sync_runs row (19).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The plan's allowed maximum (7.3): see docs/RUNBOOK.md 2.3 before changing it.
export const maxDuration = 60;

export async function POST(request: Request) {
  return runJob(
    request,
    "push",
    maxDuration,
    async ({ store, source, deadline }) => ({
      pushed: await recordedRun(
        store,
        "push",
        () => pushDue({ store, source }, { deadline }),
        pushRunSummary,
      ),
    }),
  );
}
