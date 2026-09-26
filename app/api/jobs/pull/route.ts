import { z } from "zod";

import { runJob } from "@/lib/jobs/cron";
import { discover } from "@/lib/sync/discover";
import { pullAll } from "@/lib/sync/pull";

// PRD 7.3, 13: discover + pull. Called by pg_cron every 10 minutes, and by Sync now.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  force: z.boolean().optional(),
  trackerIds: z.array(z.uuid()).optional(),
});

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  return runJob(
    request,
    "pull",
    maxDuration,
    async ({ store, source, deadline }) => {
      const discovered = await discover({ store, source });
      const outcomes = await pullAll(
        { store, source },
        {
          force: parsed.data.force,
          trackerIds: parsed.data.trackerIds,
          deadline,
        },
      );
      return { discovered, outcomes };
    },
  );
}
