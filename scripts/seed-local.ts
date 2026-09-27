// N16, PRD 17: sample users and trackers for local development and the end-to-end tests,
// without Google and without the setup wizard.
//
//   pnpm seed:local
//
// Needs a local Supabase (`pnpm exec supabase start`) and KNIT_SHEET_SOURCE=local in the
// environment or .env.local; it refuses any other database. It creates, or reuses when run
// again:
//   * an admin, admin@knit.test, with the aliases "pragaman" and "p" (so the example trackers'
//     rows are theirs), and a member, member@knit.test, with the alias "shlok";
//   * the other example people as known non-users;
//   * the example trackers of fixtures/trackers.config.json (or only those named in
//     KNIT_SEED_TRACKERS, comma separated), active from the go-live date (KNIT_SEED_GO_LIVE,
//     default today in India), with their Knit columns; the others stay New sheet found;
//   * a first pull of every tracker.
//
//   pnpm seed:local close
//
// runs the close-days job (10.5) in the same way, for every unclosed day before today: the
// end-to-end tests seed on one day, move Knit's clock on, and close the days between.
// Both users get the password in KNIT_SEED_PASSWORD, or one generated once and kept in
// .knit-local/seed-credentials.json (git ignores .knit-local). It is never printed.
// Seed before starting the app: a running server keeps its own copy of the local sheets.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { TrackerConfig } from "@/lib/domain/config";
import { baseUrl, parseEnv, supabaseServerKey } from "@/lib/env-schema";
import { getLocalSheetSource } from "@/lib/sheets/local";
import { discover } from "@/lib/sync/discover";
import { localArchive } from "@/lib/sync/archive";
import { closeDays } from "@/lib/sync/close";
import { pullAll } from "@/lib/sync/pull";
import { createSyncStore, type Rpc } from "@/lib/sync/store";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CREDENTIALS = path.join(".knit-local", "seed-credentials.json");
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";

export const SEED_USERS = [
  {
    email: "admin@knit.test",
    name: "Pragaman (local)",
    role: "admin",
    aliases: [
      ["pragaman", "Pragaman"],
      ["p", "P"],
    ],
  },
  {
    email: "member@knit.test",
    name: "Shlok (local)",
    role: "member",
    aliases: [["shlok", "Shlok"]],
  },
] as const;

const REGISTRY_KEYS = Object.keys(TrackerConfig.shape);

const FixtureFile = z.object({
  people: z.array(z.object({ alias: z.string(), user: z.string().nullable() })),
  trackers: z.array(
    z
      .object({
        fixture: z.string(),
        tab: z.string(),
        name: z.string(),
        color: z.string(),
      })
      .loose(),
  ),
});

const normalise = (value: string) =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

function seedPassword(): string {
  const fromEnv = process.env.KNIT_SEED_PASSWORD;
  if (fromEnv) return fromEnv;
  if (existsSync(CREDENTIALS)) {
    return z
      .object({ password: z.string().min(12) })
      .parse(JSON.parse(readFileSync(CREDENTIALS, "utf8"))).password;
  }
  const password = randomBytes(15).toString("base64url");
  mkdirSync(path.dirname(CREDENTIALS), { recursive: true });
  writeFileSync(
    CREDENTIALS,
    JSON.stringify(
      { users: SEED_USERS.map((u) => u.email), password },
      null,
      2,
    ),
  );
  return password;
}

async function ensureUser(
  client: SupabaseClient,
  user: (typeof SEED_USERS)[number],
  password: string,
): Promise<string> {
  const { data: list, error: listError } = await client.auth.admin.listUsers({
    perPage: 1000,
  });
  if (listError) throw new Error(`Could not list users: ${listError.message}`);
  let id = list.users.find((u) => u.email === user.email)?.id;
  if (!id) {
    const { data, error } = await client.auth.admin.createUser({
      email: user.email,
      password,
      email_confirm: true,
      user_metadata: { name: user.name },
    });
    if (error)
      throw new Error(`Could not create ${user.email}: ${error.message}`);
    id = data.user.id;
  }
  const { error } = await client.from("app_users").upsert(
    {
      id,
      name: user.name,
      email: user.email,
      role: user.role,
      is_active: true,
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`Could not save ${user.email}: ${error.message}`);
  return id;
}

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const env = parseEnv(
    z.object({
      NEXT_PUBLIC_SUPABASE_URL: baseUrl(),
      SUPABASE_SERVICE_ROLE_KEY: supabaseServerKey(),
      KNIT_SHEET_SOURCE: z.literal("local", {
        error: "must be local: the seed only fills a local database",
      }),
    }),
    process.env,
    "seed-local needs these environment variables",
  );
  const host = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname;
  if (!LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(`[${host}]`)) {
    throw new Error(
      "seed-local only runs against a local Supabase (localhost or 127.0.0.1).",
    );
  }

  const client = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data as unknown;
  };

  if (process.argv[2] === "close") {
    const source = await getLocalSheetSource();
    const { closed, failed } = await closeDays({
      store: createSyncStore(rpc),
      source,
      archive: localArchive(),
    });
    for (const day of closed) console.log(`Closed ${day.day}`);
    if (failed)
      throw new Error(`Closing ${failed.day} failed: ${failed.error}`);
    return;
  }

  // Users and people (6.7).
  const password = seedPassword();
  const ids = new Map<string, string>();
  for (const user of SEED_USERS)
    ids.set(user.email, await ensureUser(client, user, password));
  const fixtures = FixtureFile.parse(
    JSON.parse(readFileSync("fixtures/trackers.config.json", "utf8")),
  );
  const aliases = [
    ...SEED_USERS.flatMap((user) =>
      user.aliases.map(([alias, display]) => ({
        alias_norm: alias,
        display,
        user_id: ids.get(user.email)!,
      })),
    ),
    ...fixtures.people
      .filter((person) => person.user === null)
      .filter(
        (person) =>
          !SEED_USERS.some((u) =>
            u.aliases.some(([alias]) => alias === normalise(person.alias)),
          ),
      )
      .map((person) => ({
        alias_norm: normalise(person.alias),
        display: person.alias,
        user_id: null,
      })),
  ];
  const { error: aliasError } = await client
    .from("people_aliases")
    .upsert(aliases, { onConflict: "alias_norm" });
  if (aliasError)
    throw new Error(`Could not save aliases: ${aliasError.message}`);

  // Trackers (8.2), with the Knit columns the wizard would add (7.4).
  const goLive =
    process.env.KNIT_SEED_GO_LIVE ??
    z.string().parse(await rpc("knit_today", {}));
  const source = await getLocalSheetSource();
  const adminId = ids.get(SEED_USERS[0].email)!;
  const only = process.env.KNIT_SEED_TRACKERS?.split(",").map((n) => n.trim());
  for (const fixture of fixtures.trackers) {
    if (only && !only.includes(fixture.name)) continue;
    const fileId = path.basename(fixture.fixture).replace(/\.xlsx$/i, "");
    const file = (await source.listFolder()).find((f) => f.id === fileId);
    const tabs = file ? await source.listTabs(fileId) : [];
    const tab = tabs.find((t) => t.title === fixture.tab);
    if (!file || !tab) throw new Error(`Example tracker not found: ${fileId}`);
    const config = TrackerConfig.parse(
      Object.fromEntries(
        Object.entries(fixture).filter(([key]) => REGISTRY_KEYS.includes(key)),
      ),
    );
    const { data: existing } = await client
      .from("trackers")
      .select("id")
      .eq("file_id", fileId)
      .eq("sheet_gid", tab.sheetId)
      .maybeSingle();
    if (existing) continue;
    await source.ensureKnitColumns(
      { fileId, sheetId: tab.sheetId },
      config.headerRow,
    );
    const { error: fileError } = await client.from("drive_files").upsert(
      {
        file_id: fileId,
        name: file.name,
        mime_type: GOOGLE_SHEET,
        state: "connected",
      },
      { onConflict: "file_id" },
    );
    if (fileError)
      throw new Error(`Could not save ${fileId}: ${fileError.message}`);
    const { error } = await client.from("trackers").insert({
      file_id: fileId,
      sheet_gid: tab.sheetId,
      tab_name: tab.title,
      name: fixture.name,
      color: fixture.color,
      owner_user_id: adminId,
      state: "active",
      config,
      go_live_date: goLive,
    });
    if (error)
      throw new Error(`Could not save ${fixture.name}: ${error.message}`);
  }

  // A first pull (10.1, 10.2), as the pull job does.
  const store = createSyncStore(rpc);
  await discover({ store, source });
  const outcomes = await pullAll({ store, source }, { force: true });
  for (const outcome of outcomes)
    console.log(`${outcome.tracker}: ${outcome.outcome}`);
  console.log(
    `Seeded ${SEED_USERS.map((u) => u.email).join(" and ")}, go-live ${goLive}.` +
      (process.env.KNIT_SEED_PASSWORD
        ? " Password: KNIT_SEED_PASSWORD."
        : ` Password: ${CREDENTIALS}.`),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
