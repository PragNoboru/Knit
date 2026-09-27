import { beforeEach, describe, expect, it, vi } from "vitest";

import { safeNextPath } from "@/lib/url";

// PRD 9.3, 12.1: /login's `next` never sends anyone to another site (audit finding 9, 28).

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
);
const session = vi.hoisted(() => ({
  user: null as { id: string } | null,
}));

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/supabase/server", () => ({
  getCurrentUser: async () => session.user,
  getSupabase: async () => ({
    auth: {
      getClaims: async () => ({ data: null }),
      signInWithPassword: async () => ({
        data: { user: { id: "u1" } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { is_active: true } }),
        }),
      }),
    }),
  }),
}));

const OTHER_SITES = [
  "//evil.com",
  "/\\evil.com",
  "/\\evil.com/login",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  "https://evil.com",
  "evil.com",
  "",
];

describe("safeNextPath", () => {
  it.each(OTHER_SITES)("refuses %j", (next) => {
    expect(safeNextPath(next)).toBeUndefined();
  });

  it("refuses the decoded form of /%5Cevil.com", () => {
    expect(safeNextPath(decodeURIComponent("/%5Cevil.com"))).toBeUndefined();
  });

  it("keeps paths inside Knit as they are", () => {
    for (const path of [
      "/",
      "/calendar",
      "/day/2026-10-01?task=00000000-0000-4000-8000-000000000001",
      "/tasks?q=menu&page=2",
      // What proxy.ts builds from pathname + search.
      "/calendar?month=2026-10&day=2026-10-23",
    ])
      expect(safeNextPath(path)).toBe(path);
  });

  it("keeps an encoded backslash encoded, so it stays inside Knit", () => {
    expect(safeNextPath("/%5Cevil.com")).toBe("/%5Cevil.com");
  });
});

describe("the sign-in paths use it", () => {
  beforeEach(() => {
    redirect.mockClear();
    session.user = null;
  });

  it("signIn goes home instead of to another site", async () => {
    const { signIn } = await import("@/lib/actions/auth");
    const form = new FormData();
    form.set("email", "admin@knit.test");
    form.set("password", "a-password");
    form.set("next", "/\\evil.example/login");
    await expect(signIn({ error: null }, form)).rejects.toThrow(
      /^redirect:\/$/,
    );
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("signIn keeps a path inside Knit", async () => {
    const { signIn } = await import("@/lib/actions/auth");
    const form = new FormData();
    form.set("email", "admin@knit.test");
    form.set("password", "a-password");
    form.set("next", "/tasks");
    await expect(signIn({ error: null }, form)).rejects.toThrow(
      "redirect:/tasks",
    );
  });

  it("the login page sends a signed-in visitor home, not to another site", async () => {
    session.user = { id: "u1" };
    const { default: LoginPage } = await import("@/app/login/page");
    await expect(
      LoginPage({
        searchParams: Promise.resolve({ next: "/\\evil.example/login" }),
      }),
    ).rejects.toThrow(/^redirect:\/$/);
    expect(redirect).toHaveBeenCalledWith("/");
  });
});
