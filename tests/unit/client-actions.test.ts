import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import {
  adoptServerState,
  pendingTaskIds,
  pollSyncStates,
} from "@/components/sync-provider";
import { callAction, callVoidAction } from "@/lib/actions/call";
import { NETWORK_ERROR, ok } from "@/lib/errors";

// PRD 12.3, CLAUDE.md conventions: a failed request shows inline, never as the error page
// (audit finding 29); the Syncing and Not saved pills follow what the server last said
// (audit finding 30).

vi.mock("@/lib/actions/tasks", () => ({ syncStatus: vi.fn() }));

describe("callAction (finding 29)", () => {
  it("turns a request that never got an answer into a plain-language error", async () => {
    const result = await callAction(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    expect(result).toEqual({ ok: false, error: NETWORK_ERROR });
  });

  it("passes typed results through", async () => {
    expect(await callAction(async () => ok({ sync: null }))).toEqual({
      ok: true,
      data: { sync: null },
    });
    expect(
      await callAction(async () => ({ ok: false as const, error: "No." })),
    ).toEqual({ ok: false, error: "No." });
  });

  it("lets a Next.js redirect through, so an action can still navigate", async () => {
    await expect(
      callAction(async () => {
        redirect("/login");
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
    await expect(
      callVoidAction(async () => {
        redirect("/admin/trackers");
      }),
    ).rejects.toThrow("NEXT_REDIRECT");
  });

  it("callVoidAction reports a failed request instead of throwing", async () => {
    expect(
      await callVoidAction(() => Promise.reject(new TypeError("Load failed"))),
    ).toEqual({
      ok: false,
      error: NETWORK_ERROR,
    });
    expect(await callVoidAction(async () => 3)).toEqual({ ok: true, value: 3 });
  });

  it("leaves an error the server threw to the error page with retry (PRD 14, review R12)", async () => {
    // Supabase unavailable: the request reached the server, which threw.
    const thrown = () =>
      Promise.reject(
        Object.assign(new Error("app_users read failed"), { digest: "42" }),
      );
    await expect(callAction(thrown)).rejects.toThrow("app_users read failed");
    await expect(callVoidAction(thrown)).rejects.toThrow(
      "app_users read failed",
    );
  });

  it("counts any failure while the browser is offline as a request that never got through", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      expect(
        await callAction(() => Promise.reject(new Error("aborted"))),
      ).toEqual({ ok: false, error: NETWORK_ERROR });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the Syncing poll (finding 29, 30)", () => {
  it("follows only pending write-backs (N18 h)", () => {
    expect(
      pendingTaskIds({ b: "pending", a: "pending", c: "held", d: null }),
    ).toEqual(["a", "b"]);
  });

  it("a poll that cannot reach the server changes nothing and does not throw", async () => {
    expect(
      await pollSyncStates(["a"], () => Promise.reject(new TypeError("x"))),
    ).toBeNull();
    // A server that could not answer: the background poll just tries again (review R12).
    expect(
      await pollSyncStates(["a"], () =>
        Promise.reject(new Error("app_users read failed")),
      ),
    ).toBeNull();
    expect(
      await pollSyncStates(["a", "b"], async () => ok({ a: "failed" })),
    ).toEqual({ a: "failed", b: null });
  });
});

describe("adoptServerState (finding 30)", () => {
  it("a held write-back that landed after Resume clears", () => {
    // The page learned "held" from a poll; after Resume the server renders nothing waiting.
    const states = { t: "held" as const };
    expect(adoptServerState(states, "t", null, "held")).toEqual({ t: null });
  });

  it("a failed write-back retried by the admin clears", () => {
    expect(adoptServerState({ t: "failed" }, "t", null, "failed")).toEqual({
      t: null,
    });
    expect(adoptServerState({ t: "failed" }, "t", "pending", "failed")).toEqual(
      { t: "pending" },
    );
  });

  it("a new write-back from a correction shows and joins the poll", () => {
    const next = adoptServerState({ t: null }, "t", "pending", null);
    expect(next).toEqual({ t: "pending" });
    expect(pendingTaskIds(next)).toEqual(["t"]);
  });

  it("an unchanged server render does not undo what an action or poll learned", () => {
    const states = { t: null };
    expect(adoptServerState(states, "t", "pending", "pending")).toBe(states);
  });

  it("a first render takes the server's value", () => {
    expect(adoptServerState({}, "t", "failed", undefined)).toEqual({
      t: "failed",
    });
  });
});
