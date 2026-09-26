import "server-only";

import { z } from "zod";

import {
  baseUrl,
  parseEnv,
  required,
  supabaseServerKey,
  type EnvSource,
} from "@/lib/env-schema";
import { publicEnvSchema } from "@/lib/public-env";

/**
 * Server environment (PRD 18.1). All eight variables are required and are
 * validated when the server starts (instrumentation.ts), so a misconfigured
 * deployment fails at boot instead of on the first request. The `server-only`
 * import makes the build fail if client code ever imports this module
 * (CLAUDE.md invariant 10).
 */

const serviceAccountKey = z.object({
  type: z.literal("service_account"),
  project_id: z.string().optional(),
  private_key_id: z.string().optional(),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
  client_email: z.email(),
  client_id: z.string().optional(),
});

export type ServiceAccountKey = z.infer<typeof serviceAccountKey>;

/**
 * GOOGLE_SERVICE_ACCOUNT_JSON holds the key file base64-encoded (PRD 7.4).
 * Line breaks inside the base64 text (as `base64` wraps it) are ignored.
 */
const serviceAccountJson = () =>
  required().transform((value, ctx): ServiceAccountKey => {
    const base64 = value.replace(/\s+/g, "");
    let decoded: unknown;
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error();
      decoded = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    } catch {
      ctx.addIssue({ code: "custom", message: "is not base64-encoded JSON" });
      return z.NEVER;
    }
    const key = serviceAccountKey.safeParse(decoded);
    if (!key.success) {
      ctx.addIssue({
        code: "custom",
        message:
          "is not a Google service account key (needs type service_account, client_email and private_key)",
      });
      return z.NEVER;
    }
    return key.data;
  });

/** Google Drive file and folder ids: letters, digits, `-` and `_`. */
const driveId = () =>
  required().regex(/^[A-Za-z0-9_-]{10,}$/, "is not a Google Drive id");

export const serverEnvSchema = publicEnvSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: supabaseServerKey(),
  GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
  KNIT_DRIVE_FOLDER_ID: driveId(),
  KNIT_ARCHIVE_SHEET_ID: driveId(),
  KNIT_CRON_SECRET: required().min(32, "must be at least 32 characters"),
  APP_URL: baseUrl(),
});

/** Validated server environment. GOOGLE_SERVICE_ACCOUNT_JSON is decoded. */
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: EnvSource): ServerEnv {
  return parseEnv(
    serverEnvSchema,
    source,
    "Knit cannot start: environment variables are missing or invalid",
  );
}

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}
