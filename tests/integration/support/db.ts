import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

/**
 * Database access for integration tests (PRD 17).
 *
 * `supabase` (default): the local Supabase started by `pnpm exec supabase start`, which has
 * already applied the migrations and seed. This is the reference, and what CI runs.
 * `pglite`: Postgres in-process, with a stand-in for Supabase's auth schema; migrations are
 * applied on open. For machines without Docker.
 *
 * Every test runs inside a transaction that is rolled back, so tests never see each other's
 * rows. Dates are compared as text (`day::text`) so the process timezone never matters.
 */

export type Row = Record<string, unknown>;

export interface Db {
  query<R extends Row = Row>(sql: string, params?: unknown[]): Promise<R[]>;
  close(): Promise<void>;
}

export type Driver = "supabase" | "pglite";

export const driver: Driver =
  process.env.KNIT_TEST_DB === "pglite" ? "pglite" : "supabase";

export const LOCAL_SUPABASE_DB_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const repoFile = (relative: string) =>
  fileURLToPath(new URL(`../../../${relative}`, import.meta.url));

function migrationFiles(): string[] {
  const dir = repoFile("supabase/migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => `${dir}/${name}`);
}

async function openSupabase(): Promise<Db> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_URL ?? LOCAL_SUPABASE_DB_URL,
  });
  await client.connect();
  return {
    async query<R extends Row>(sql: string, params?: unknown[]) {
      const result = await client.query<R>(sql, params);
      return result.rows;
    },
    close: () => client.end(),
  };
}

async function openPglite(): Promise<Db> {
  const db = new PGlite();
  await db.exec(
    readFileSync(
      repoFile("tests/integration/support/pglite-supabase.sql"),
      "utf8",
    ),
  );
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${String(error)}`, {
        cause: error,
      });
    }
  }
  await db.exec(readFileSync(repoFile("supabase/seed.sql"), "utf8"));
  return {
    async query<R extends Row>(sql: string, params?: unknown[]) {
      const result = await db.query<R>(sql, params);
      return result.rows;
    },
    close: () => db.close(),
  };
}

export function openDb(): Promise<Db> {
  return driver === "pglite" ? openPglite() : openSupabase();
}

/**
 * Opens one connection per test file and wraps every test in a transaction that is rolled
 * back afterwards. Call at the top of a describe block; use the returned getter in tests.
 */
export function useTestDb(): () => Db {
  let db: Db | undefined;
  beforeAll(async () => {
    db = await openDb();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db?.query("begin");
  });
  afterEach(async () => {
    await db?.query("rollback");
  });
  return () => {
    if (!db) throw new Error("database not open");
    return db;
  };
}

/** Freezes knit_today() for the current transaction (PRD 17: time is injected). */
export async function setToday(db: Db, day: string): Promise<void> {
  await db.query("select set_config('knit.today', $1, true)", [day]);
}

export type Actor =
  { kind: "user"; id: string } | { kind: "service" } | { kind: "anon" };

/**
 * Runs `fn` as an API caller would: with the request JWT claims PostgREST would set, under
 * the matching database role. Everything runs in a savepoint, so a failing call leaves the
 * test transaction usable, and the role is always restored.
 */
export async function act<T>(
  db: Db,
  actor: Actor,
  fn: () => Promise<T>,
): Promise<T> {
  const role =
    actor.kind === "user"
      ? "authenticated"
      : actor.kind === "service"
        ? "service_role"
        : "anon";
  const claims =
    actor.kind === "user" ? { sub: actor.id, role: "authenticated" } : { role };
  await db.query("savepoint knit_act");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await db.query(`set local role ${role}`);
    const result = await fn();
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("release savepoint knit_act");
    return result;
  } catch (error) {
    await db.query("rollback to savepoint knit_act");
    throw error;
  }
}

/** Shorthand: run one statement as `actor` and return its rows. */
export function queryAs<R extends Row = Row>(
  db: Db,
  actor: Actor,
  sql: string,
  params?: unknown[],
): Promise<R[]> {
  return act(db, actor, () => db.query<R>(sql, params));
}
