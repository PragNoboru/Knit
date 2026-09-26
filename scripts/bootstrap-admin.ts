// PRD 18.4: creates the first admin: the Supabase Auth user for pragaman@noboruworld.com, the
// app_users row with role admin, and the aliases "pragaman" and "p". Safe to run again: an
// existing user is reused and never gets a new password.
//
//   pnpm bootstrap:admin
//
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or
// .env.local. The password is typed at a hidden prompt, never passed as an argument or logged.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { baseUrl, parseEnv, supabaseServerKey } from "@/lib/env-schema";

export const FIRST_ADMIN = {
  email: "pragaman@noboruworld.com",
  name: "Pragaman Kumar Anurag",
  aliases: [
    { alias: "pragaman", display: "Pragaman" },
    { alias: "p", display: "P" },
  ],
};

export interface BootstrapInput {
  email: string;
  name: string;
  aliases: { alias: string; display: string }[];
  /** Asked only when the auth user does not exist yet. */
  password: () => Promise<string>;
}

async function findUserIdByEmail(
  client: SupabaseClient,
  email: string,
): Promise<string | null> {
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) throw new Error(`Could not list auth users: ${error.message}`);
    const match = data.users.find(
      (user) => user.email?.toLowerCase() === email.toLowerCase(),
    );
    if (match) return match.id;
    if (data.users.length < perPage) return null;
  }
}

/** Same rule as knit_normalise in SQL: trim, lowercase, collapse whitespace. */
function normaliseAlias(alias: string): string {
  return alias.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function bootstrapAdmin(
  client: SupabaseClient,
  input: BootstrapInput,
): Promise<{ userId: string; created: boolean }> {
  let userId = await findUserIdByEmail(client, input.email);
  let created = false;
  if (!userId) {
    const { data, error } = await client.auth.admin.createUser({
      email: input.email,
      password: await input.password(),
      email_confirm: true,
      user_metadata: { name: input.name },
    });
    if (error)
      throw new Error(`Could not create the auth user: ${error.message}`);
    userId = data.user.id;
    created = true;
  }

  const { error: userError } = await client.from("app_users").upsert(
    {
      id: userId,
      name: input.name,
      email: input.email,
      role: "admin",
      is_active: true,
    },
    { onConflict: "id" },
  );
  if (userError)
    throw new Error(`Could not save the admin: ${userError.message}`);

  const { error: aliasError } = await client.from("people_aliases").upsert(
    input.aliases.map(({ alias, display }) => ({
      alias_norm: normaliseAlias(alias),
      display,
      user_id: userId,
    })),
    { onConflict: "alias_norm" },
  );
  if (aliasError)
    throw new Error(`Could not save the aliases: ${aliasError.message}`);

  return { userId, created };
}

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error("Run this in a terminal: the password is typed at a prompt."),
    );
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === CTRL_C) return finish(new Error("Cancelled."));
        if (char === BACKSPACE || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function askNewPassword(): Promise<string> {
  const password = await promptHidden(
    `New password for ${FIRST_ADMIN.email}: `,
  );
  const again = await promptHidden("Type it again: ");
  if (password !== again)
    throw new Error("The two passwords differ. Nothing was created.");
  if (password.length === 0)
    throw new Error("The password is empty. Nothing was created.");
  return password;
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const env = parseEnv(
    z.object({
      NEXT_PUBLIC_SUPABASE_URL: baseUrl(),
      SUPABASE_SERVICE_ROLE_KEY: supabaseServerKey(),
    }),
    process.env,
    "bootstrap-admin needs these environment variables",
  );
  const client = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { userId, created } = await bootstrapAdmin(client, {
    ...FIRST_ADMIN,
    password: askNewPassword,
  });
  console.log(
    created
      ? `Created the admin ${FIRST_ADMIN.email} (${userId}) with aliases "pragaman" and "p".`
      : `The admin ${FIRST_ADMIN.email} (${userId}) already existed; its admin row and aliases are in place.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
