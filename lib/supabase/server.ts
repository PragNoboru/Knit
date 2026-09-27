import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

import { authCookieOptions } from "./cookies";

/**
 * The signed-in user's Supabase client for Server Components and server actions. Every query
 * runs under the user's JWT, so RLS and the RPC functions' own checks apply (PRD 9). One
 * client per request.
 */
export const getSupabase = cache(async (): Promise<SupabaseClient> => {
  // cookies() first: it marks the page as rendered per request, before anything reads the
  // environment (so the build never needs the server secrets).
  const store = await cookies();
  const env = getServerEnv();
  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookieOptions: authCookieOptions(env.APP_URL),
      cookies: {
        getAll: () => store.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet)
              store.set(name, value, options);
          } catch {
            // A Server Component cannot set cookies; proxy.ts keeps the session fresh.
          }
        },
      },
    },
  );
});

const AppUserRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
  is_active: z.boolean(),
});

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

/** The signed-in, active Knit user, or null (signed out, or deactivated by the admin). */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await getSupabase();
  const { data: auth } = await supabase.auth.getClaims();
  const id = auth?.claims.sub;
  if (!id) return null;
  const { data, error } = await supabase
    .from("app_users")
    .select("id, name, email, role, is_active")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`app_users read failed: ${error.code}`);
  const row = AppUserRow.nullable().parse(data);
  if (!row || !row.is_active) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: row.role === "admin",
  };
});

/** A database function refused the call; `code` is what it raised (see lib/errors.ts). */
export class RpcError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string,
  ) {
    super(code);
    this.name = "RpcError";
  }
}

/** Calls a database function as the signed-in user and parses the result with zod. */
export async function callRpc<T>(
  schema: z.ZodType<T>,
  fn: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new RpcError(fn, error.message);
  return schema.parse(data);
}
