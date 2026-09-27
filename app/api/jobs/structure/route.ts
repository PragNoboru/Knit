import { runJob } from "@/lib/jobs/cron";
import { structureCheckAll } from "@/lib/sync/structure-job";

// PRD 7.3: the daily structure check, 06:30 IST.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The plan's allowed maximum (7.3): see docs/RUNBOOK.md 2.3 before changing it.
export const maxDuration = 60;

export async function POST(request: Request) {
  return runJob(
    request,
    "structure",
    maxDuration,
    async ({ store, source }) => ({
      structure: await structureCheckAll({ store, source }),
    }),
  );
}
