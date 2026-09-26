import { runJob } from "@/lib/jobs/cron";
import { pushDue } from "@/lib/sync/push";

// PRD 7.3, 10.4: write-backs, every minute. The immediate push after a status change is the
// fast path; this is the retry path.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return runJob(
    request,
    "push",
    maxDuration,
    async ({ store, source, deadline }) => ({
      pushed: await pushDue({ store, source }, { deadline }),
    }),
  );
}
