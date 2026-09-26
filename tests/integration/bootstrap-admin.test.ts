import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { bootstrapAdmin } from "@/scripts/bootstrap-admin";

import { driver } from "./support/db";
import { localSupabaseApi } from "./support/local-supabase";

// PRD 18.4. Goes through the Auth API, so it needs real local Supabase (skipped on PGlite).
// Auth writes cannot be rolled back, so the test cleans up after itself.
describe.runIf(driver === "supabase")("bootstrap-admin (PRD 18.4)", () => {
  it("creates the admin with its aliases once, and is safe to run again", async () => {
    const { url, serviceRoleKey } = localSupabaseApi();
    const client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const suffix = randomUUID().slice(0, 8);
    const input = {
      email: `bootstrap-${suffix}@test.knit`,
      name: "Test Admin",
      aliases: [
        { alias: `Test  Admin ${suffix}`, display: "Test Admin" },
        { alias: `ta-${suffix}`, display: "TA" },
      ],
    };

    const first = await bootstrapAdmin(client, {
      ...input,
      password: async () => `pw-${randomUUID()}`,
    });
    try {
      expect(first.created).toBe(true);

      const second = await bootstrapAdmin(client, {
        ...input,
        password: () =>
          Promise.reject(new Error("must not ask for a password again")),
      });
      expect(second).toEqual({ userId: first.userId, created: false });

      const { data: user } = await client
        .from("app_users")
        .select("email, role, is_active")
        .eq("id", first.userId)
        .single();
      expect(user).toEqual({
        email: input.email,
        role: "admin",
        is_active: true,
      });

      const { data: aliases } = await client
        .from("people_aliases")
        .select("alias_norm, user_id")
        .eq("user_id", first.userId)
        .order("alias_norm");
      expect(aliases).toEqual([
        { alias_norm: `ta-${suffix}`, user_id: first.userId },
        { alias_norm: `test admin ${suffix}`, user_id: first.userId },
      ]);
    } finally {
      await client.from("people_aliases").delete().eq("user_id", first.userId);
      await client.auth.admin.deleteUser(first.userId);
    }
  });
});
