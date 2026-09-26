import { z } from "zod";

/**
 * Validators shared by lib/public-env.ts (browser-safe), lib/env.ts (server
 * only) and scripts. This module holds rules, never values.
 *
 * Error messages name the variable and the problem, never the value.
 */

export class EnvError extends Error {
  override name = "EnvError";
}

export type EnvSource = Record<string, string | undefined>;

/** A required, non-empty string. */
export const required = () =>
  z.string({ error: "is missing" }).trim().min(1, "is empty");

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** An http(s) base URL without a trailing slash, so paths can be appended. */
export const baseUrl = () =>
  required()
    .refine(isHttpUrl, "must be an http or https URL")
    .refine((value) => !value.endsWith("/"), "must not end with a slash");

export type SupabaseKeyKind =
  "anon" | "service_role" | "publishable" | "secret" | "unknown";

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

/**
 * Tells Supabase key types apart without trusting the variable name: new keys
 * carry a prefix, legacy keys are JWTs with a `role` claim.
 */
export function supabaseKeyKind(key: string): SupabaseKeyKind {
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  const payload = key.split(".")[1];
  if (key.split(".").length !== 3 || payload === undefined) return "unknown";
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    if (typeof claims !== "object" || claims === null) return "unknown";
    const role = (claims as { role?: unknown }).role;
    if (role === "anon" || role === "service_role") return role;
  } catch {
    return "unknown";
  }
  return "unknown";
}

/** The key that browsers may see: anon (legacy) or publishable. */
export const supabasePublicKey = () =>
  required().superRefine((key, ctx) => {
    const kind = supabaseKeyKind(key);
    if (kind === "service_role" || kind === "secret") {
      ctx.addIssue({
        code: "custom",
        message:
          "holds a service-role or secret key, which would be sent to every browser; use the anon or publishable key",
      });
    } else if (kind === "unknown") {
      ctx.addIssue({
        code: "custom",
        message: "is not a Supabase anon or publishable key",
      });
    }
  });

/** The server key: service_role (legacy) or secret. */
export const supabaseServerKey = () =>
  required().superRefine((key, ctx) => {
    const kind = supabaseKeyKind(key);
    if (kind === "anon" || kind === "publishable") {
      ctx.addIssue({
        code: "custom",
        message:
          "holds the public anon or publishable key; use the service-role or secret key",
      });
    } else if (kind === "unknown") {
      ctx.addIssue({
        code: "custom",
        message: "is not a Supabase service-role or secret key",
      });
    }
  });

export function describeEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
}

/** Parses `source` with `schema`, throwing an EnvError that lists every problem. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: EnvSource,
  heading: string,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      `${heading} (see .env.example):\n${describeEnvIssues(result.error)}`,
    );
  }
  return result.data;
}
