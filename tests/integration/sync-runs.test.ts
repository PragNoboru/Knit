import { beforeEach, describe, expect, it } from "vitest";

import {
  closeRunSummary,
  pushRunSummary,
  recordedRun,
  recordLeaseSkipped,
} from "@/lib/jobs/cron";
import { MemorySheetSource } from "@/lib/sheets/memory";
import { pushDue } from "@/lib/sync/push";

import { createUser } from "./support/builders";
import { queryAs, setToday, useTestDb } from "./support/db";
import { storeFor } from "./support/store";

// PRD 19 (audit finding 41): sync_runs for every job call that did something, failed, or was
// skipped because another call held the lease, so Sync health shows push and close runs, their
// errors, and overlaps.

type Run = {
  job: string;
  ok: boolean;
  stats: Record<string, unknown>;
  error: string | null;
  finished: boolean;
};

describe("job runs in sync_runs", () => {
  const db = useTestDb();
  const runs = () =>
    db().query<Run>(
      "select job, ok, stats, error, finished_at is not null as finished from sync_runs order by id",
    );

  beforeEach(async () => {
    await setToday(db(), "2026-09-28");
  });

  it("a push call that claimed write-backs is a run; one that found nothing is not", async () => {
    const store = storeFor(db());
    const idle = await recordedRun(
      store,
      "push",
      () => pushDue({ store, source: new MemorySheetSource([]) }),
      pushRunSummary,
    );
    expect(idle).toMatchObject({ claimed: 0 });
    expect(await runs()).toEqual([]);

    await recordedRun(
      store,
      "push",
      async () => ({ claimed: 3, done: 2, retried: 1, failed: 0 }),
      pushRunSummary,
    );
    expect(await runs()).toEqual([
      {
        job: "push",
        ok: false,
        stats: { claimed: 3, done: 2, retried: 1, failed: 0 },
        error: "1 write-backs wait for a retry, 0 failed",
        finished: true,
      },
    ]);
  });

  it("a close call that closed a day, or failed, is a run", async () => {
    const store = storeFor(db());
    await recordedRun(
      store,
      "close",
      async () => ({ closed: [], failed: null }),
      closeRunSummary,
    );
    await recordedRun(
      store,
      "close",
      async () => ({
        closed: [{ day: "2026-09-26" }],
        failed: { day: "2026-09-27", error: "sheets_429" },
      }),
      closeRunSummary,
    );
    expect(await runs()).toEqual([
      {
        job: "close",
        ok: false,
        stats: { closed: 1, days: "2026-09-26", failedDay: "2026-09-27" },
        error: "sheets_429",
        finished: true,
      },
    ]);
  });

  it("a call that throws is a failed run, and the error still goes up", async () => {
    await expect(
      recordedRun(
        storeFor(db()),
        "close",
        () => Promise.reject(new Error("boom")),
        closeRunSummary,
      ),
    ).rejects.toThrow("boom");
    const [run] = await runs();
    expect(run).toMatchObject({
      job: "close",
      ok: false,
      stats: { outcome: "failed" },
    });
    expect(run!.error).toBeTruthy();
  });

  it("a call that found the lease held is a skipped run", async () => {
    await recordLeaseSkipped(storeFor(db()), "push", new Date().toISOString());
    expect(await runs()).toEqual([
      {
        job: "push",
        ok: true,
        stats: { outcome: "skipped", reason: "another call holds the lease" },
        error: null,
        finished: true,
      },
    ]);
  });

  it("only the jobs may record runs", async () => {
    const member = await createUser(db(), { name: "Member" });
    await expect(
      queryAs(
        db(),
        { kind: "user", id: member },
        "select record_sync_run('push', now(), true, '{}'::jsonb)",
      ),
    ).rejects.toThrow(/permission denied|not_allowed/);
  });
});
