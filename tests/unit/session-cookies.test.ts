import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_MAX_AGE_SECONDS,
  withSessionMaxAge,
} from "@/lib/supabase/cookies";

import { validEnv } from "../support/fake-env";

// D5 (audit finding 33): a session is kept 30 days. @supabase/ssr hands every cookie write a
// maxAge of 400 days, after the caller's own options; Knit must write 30.

const LIBRARY_MAX_AGE = 400 * 24 * 60 * 60;

type SetAll = (
  cookies: { name: string; value: string; options: Record<string, unknown> }[],
  headers: Record<string, string>,
) => void;

const library = vi.hoisted(() => ({
  writes: [] as {
    name: string;
    value: string;
    options: Record<string, unknown>;
  }[],
}));

// The library as it behaves: on a refresh it calls setAll with its own options.
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: SetAll } },
  ) => ({
    auth: {
      getClaims: async () => {
        options.cookies.setAll(library.writes, {});
        return { data: { claims: { sub: "user-1" } } };
      },
    },
  }),
}));

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  getAll: () => [],
}));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

describe("session cookie lifetime (D5)", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(validEnv()))
      vi.stubEnv(key, value);
    library.writes = [
      {
        name: "sb-knit-auth-token",
        value: "fresh",
        options: { path: "/", httpOnly: true, maxAge: LIBRARY_MAX_AGE },
      },
      {
        name: "sb-knit-auth-token.1",
        value: "",
        options: { path: "/", httpOnly: true, maxAge: 0 },
      },
    ];
    cookieStore.set.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("withSessionMaxAge keeps 30 days for a write and 0 for a removal", () => {
    expect(withSessionMaxAge({ maxAge: LIBRARY_MAX_AGE }).maxAge).toBe(
      2_592_000,
    );
    expect(
      withSessionMaxAge<{ path: string; maxAge?: number }>({ path: "/" })
        .maxAge,
    ).toBe(SESSION_MAX_AGE_SECONDS);
    expect(withSessionMaxAge({ maxAge: 0 }).maxAge).toBe(0);
  });

  it("the proxy writes a refreshed session for 30 days", async () => {
    const { proxy } = await import("@/proxy");
    const response = await proxy(new NextRequest("http://localhost:3000/"));
    expect(response.cookies.get("sb-knit-auth-token")?.maxAge).toBe(2_592_000);
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=2592000/);
    expect(response.cookies.get("sb-knit-auth-token.1")?.maxAge).toBe(0);
  });

  it("server actions write a refreshed session for 30 days", async () => {
    const { getSupabase } = await import("@/lib/supabase/server");
    const client = await getSupabase();
    await client.auth.getClaims();
    expect(cookieStore.set).toHaveBeenCalledWith(
      "sb-knit-auth-token",
      "fresh",
      expect.objectContaining({ maxAge: 2_592_000 }),
    );
    expect(cookieStore.set).toHaveBeenCalledWith(
      "sb-knit-auth-token.1",
      "",
      expect.objectContaining({ maxAge: 0 }),
    );
  });
});
