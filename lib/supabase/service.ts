import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env";
import type { Rpc } from "@/lib/sync/store";

/**
 * PRD 9.3, invariant 10: the service-role client, for job endpoints and admin server actions
 * only. `server-only` makes the build fail if browser code ever imports this module.
 */
export function createServiceClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

/** Calls SQL functions through PostgREST; an error names the function, never the data. */
export function serviceRpc(
  client: SupabaseClient = createServiceClient(),
): Rpc {
  return async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error)
      throw new Error(
        `${fn} failed: ${error.code ?? ""} ${error.message}`.trim(),
      );
    return data as unknown;
  };
}
