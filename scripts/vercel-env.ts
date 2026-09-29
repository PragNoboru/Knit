// PRD 18.1, docs/RUNBOOK.md 2.3: the production environment variables, ready to paste into
// Vercel (its Environment Variables section accepts a whole .env block pasted into the first
// Key field).
//
//   pnpm vercel:env [https://<app>.vercel.app]
//
// Reads .env.local for the Supabase and Google values, makes KNIT_CRON_SECRET once (and keeps
// it in .env.local, because cron.sql needs the same value later), and writes the block to
// .knit-local/vercel.env (git ignores .knit-local) and to the clipboard on Windows. It prints
// the variable names only, never a value.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  baseUrl,
  driveId,
  parseEnv,
  required,
  serviceAccountJson,
  supabasePublicKey,
  supabaseServerKey,
} from "@/lib/env-schema";

const ENV_FILE = ".env.local";
const OUT = path.join(".knit-local", "vercel.env");

function main() {
  if (!existsSync(ENV_FILE))
    throw new Error("No .env.local: do the Google and Supabase steps first.");
  process.loadEnvFile(ENV_FILE);
  // Made once and kept: cron.sql needs the same value (RUNBOOK 2.4).
  if (!process.env.KNIT_CRON_SECRET) {
    const secret = randomBytes(32).toString("hex");
    const text = readFileSync(ENV_FILE, "utf8");
    appendFileSync(
      ENV_FILE,
      `${text.endsWith("\n") ? "" : "\n"}KNIT_CRON_SECRET=${secret}\n`,
    );
    process.env.KNIT_CRON_SECRET = secret;
  }
  const appUrl =
    process.argv[2] ?? process.env.APP_URL ?? "https://knit.vercel.app";
  const env = parseEnv(
    z.object({
      NEXT_PUBLIC_SUPABASE_URL: baseUrl(),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: supabasePublicKey(),
      SUPABASE_SERVICE_ROLE_KEY: supabaseServerKey(),
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
      KNIT_DRIVE_FOLDER_ID: driveId(),
      KNIT_ARCHIVE_SHEET_ID: driveId(),
      KNIT_CRON_SECRET: required().min(32, "must be at least 32 characters"),
      APP_URL: baseUrl(),
    }),
    { ...process.env, APP_URL: appUrl },
    "vercel:env needs these values in .env.local",
  );
  if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname === "127.0.0.1")
    throw new Error("NEXT_PUBLIC_SUPABASE_URL points at a local database.");

  // The raw (still base64) key, as Vercel must hold it.
  const raw = (name: string) => String(process.env[name] ?? "").trim();
  const lines: [string, string][] = [
    ["NEXT_PUBLIC_SUPABASE_URL", env.NEXT_PUBLIC_SUPABASE_URL],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.NEXT_PUBLIC_SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
    ["GOOGLE_SERVICE_ACCOUNT_JSON", raw("GOOGLE_SERVICE_ACCOUNT_JSON")],
    ["KNIT_DRIVE_FOLDER_ID", env.KNIT_DRIVE_FOLDER_ID],
    ["KNIT_ARCHIVE_SHEET_ID", env.KNIT_ARCHIVE_SHEET_ID],
    ["KNIT_CRON_SECRET", env.KNIT_CRON_SECRET],
    ["APP_URL", env.APP_URL],
    ["ENABLE_EXPERIMENTAL_COREPACK", "1"],
  ];
  const block = lines.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, block);
  const copied =
    process.platform === "win32" &&
    spawnSync("clip", { input: block }).status === 0;
  console.log(`Ready: ${lines.map(([k]) => k).join(", ")}.`);
  console.log(`APP_URL is ${env.APP_URL}.`);
  console.log(
    copied
      ? `Copied to the clipboard, and saved in ${OUT}.`
      : `Saved in ${OUT}: open it, select all and copy.`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
