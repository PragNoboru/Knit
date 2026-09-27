import { runJob } from "@/lib/jobs/cron";
import { structureCheckAll } from "@/lib/sync/structure-job";

// PRD 7.3: the daily structure check, 06:30 IST.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
