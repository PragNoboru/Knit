import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleSheetSource } from "@/lib/sheets/google";
import { SheetError } from "@/lib/sheets/types";

// PRD N88: a request check gives its Google client a deadline, 40 s after the check started.
// Nothing is sent and nothing waited for after it, a request in flight then is abandoned, and a
// retry whose wait would end past it is not made, so discover's listing and the sheet reads
// always end in time for the check to answer.

const START = Date.UTC(2026, 9, 4, 6, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

function source(
  answer: (signal: AbortSignal | undefined) => Promise<Response>,
  deadline: number,
) {
  const calls: (AbortSignal | undefined)[] = [];
  const sleeps: number[] = [];
  const google = new GoogleSheetSource({
    folderId: "folder-1",
    getToken: async () => "token",
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      calls.push(signal);
      return answer(signal);
    }) as typeof fetch,
    // The waits pass on the fake clock, so the deadline sees them.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      vi.setSystemTime(Date.now() + ms);
    },
    deadline,
  });
  return { google, calls, sleeps };
}

const never = () => new Promise<Response>(() => undefined);

describe("a Google client with a deadline (N88)", () => {
  it("abandons a request still in flight at the deadline, aborting its fetch", async () => {
    const { google, calls } = source(never, START + 40_000);
    let outcome: unknown = "pending";
    const listing = google.listFolder().then(
      () => "listed",
      (error: unknown) => error,
    );
    void listing.then((value) => (outcome = value));
    await vi.advanceTimersByTimeAsync(39_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(SheetError);
    expect(outcome).toMatchObject({ code: "timeout" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.aborted).toBe(true);
  });

  it("sends nothing once the deadline has passed", async () => {
    const { google, calls } = source(never, START - 1);
    await expect(google.listFolder()).rejects.toMatchObject({
      code: "timeout",
    });
    expect(calls).toEqual([]);
  });

  it("does not wait for a retry that would end past the deadline: the 429 fails at once", async () => {
    const { google, calls, sleeps } = source(
      async () => new Response("{}", { status: 429 }),
      START + 10_000,
    );
    await expect(google.getFileModifiedTime("sheet-1")).rejects.toMatchObject({
      code: "api_error",
      status: 429,
    });
    // 2 s and 4 s (plus jitter) are waited; 8 s more would end past 10 s, so it is not.
    expect(sleeps).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(Date.now()).toBeLessThan(START + 10_000);
  });

  it("answers as before when Google answers in time", async () => {
    const { google } = source(
      async () =>
        new Response(JSON.stringify({ modifiedTime: "t9" }), { status: 200 }),
      START + 40_000,
    );
    expect(await google.getFileModifiedTime("sheet-1")).toBe("t9");
  });
});
