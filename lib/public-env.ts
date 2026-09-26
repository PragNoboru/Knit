import { z } from "zod";

import {
  baseUrl,
  parseEnv,
  supabasePublicKey,
  type EnvSource,
} from "@/lib/env-schema";

/**
 * Browser-safe environment (PRD 18.1): only the NEXT_PUBLIC_ variables, which
 * Next.js inlines into the browser bundle. Server-only variables live in
 * lib/env.ts.
 */

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: baseUrl(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: supabasePublicKey(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

export function parsePublicEnv(source: EnvSource): PublicEnv {
  return parseEnv(
    publicEnvSchema,
    source,
    "Invalid public environment variables",
  );
}

let cachedPublicEnv: PublicEnv | undefined;

export function getPublicEnv(): PublicEnv {
  // Each variable is named in full: Next.js only inlines NEXT_PUBLIC_ values
  // into the browser bundle when the property access is written out.
  cachedPublicEnv ??= parsePublicEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return cachedPublicEnv;
}
