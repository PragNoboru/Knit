import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validEnv } from "../support/fake-env";

// PRD 12.1, 9.3, CLAUDE.md conventions (audit finding 29): a signed-out page request goes to
// /login; a server action call is left to the action, which says in plain language that the
// session has ended (a redirect would reach the page as a failed request).

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: null }) },
  }),
}));

describe("proxy for a signed-out visitor", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(validEnv()))
      vi.stubEnv(key, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends a page request to /login, keeping where they were going", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(
      new NextRequest("http://localhost:3000/calendar?month=2026-10"),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fcalendar%3Fmonth%3D2026-10",
    );
  });

  it("lets a server action call through to the action's own check", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(
      new NextRequest("http://localhost:3000/", {
        method: "POST",
        headers: { "next-action": "abc123" },
      }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
