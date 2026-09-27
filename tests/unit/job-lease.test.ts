import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validEnv } from "../support/fake-env";

// PRD 7.3, 19 (audit finding 41): a job call that finds its lease held does nothing, and
// Sync health shows it as a "skipped" run.

const calls = vi.hoisted(() => [] as { fn: string; args: unknown }[]);
const lease = vi.hoisted(() => ({ holder: null as string | null }));

vi.mock("@/lib/supabase/service", () => ({
  serviceRpc: () => async (fn: string, args: unknown) => {
    calls.push({ fn, args });
    if (fn === "acquire_lease") return lease.holder;
    return null;
  },
}));
vi.mock("@/lib/sheets/factory", () => ({ sheetSourceFor: async () => ({}) }));

describe("withJobLease", () => {
  beforeEach(() => {
    calls.length = 0;
    for (const [key, value] of Object.entries(validEnv()))
      vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("records a skipped run when another call holds the lease", async () => {
    lease.holder = null;
    const { withJobLease } = await import("@/lib/jobs/cron");
    const work = vi.fn();
    expect(await withJobLease("push", 60, work)).toEqual({ skipped: true });
    expect(work).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual([
      "acquire_lease",
      "record_sync_run",
    ]);
    expect(calls[1]!.args).toMatchObject({
      p_job: "push",
      p_ok: true,
      p_stats: { outcome: "skipped", reason: "another call holds the lease" },
    });
  });

  it("records nothing extra when it holds the lease: the job records its own run", async () => {
    lease.holder = "00000000-0000-4000-8000-000000000009";
    const { withJobLease } = await import("@/lib/jobs/cron");
    expect(await withJobLease("pull", 60, async () => "done")).toEqual({
      skipped: false,
      result: "done",
    });
    expect(calls.map((c) => c.fn)).toEqual(["acquire_lease", "release_lease"]);
  });
});
