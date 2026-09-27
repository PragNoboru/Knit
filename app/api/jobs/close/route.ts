import { runJob } from "@/lib/jobs/cron";
import { closeDays } from "@/lib/sync/close";

// PRD 7.3, 10.5: close every unclosed day before today, oldest first. Every 15 minutes; a
// no-op once all days are closed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return runJob(
    request,
    "close",
    maxDuration,
    async ({ store, source, archive, deadline }) => ({
      ...(await closeDays({ store, source, archive }, { deadline })),
    }),
  );
}
