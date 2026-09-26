import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Integration tests (PRD 17): SQL functions, row level security and the bootstrap script
// against a real database. `pnpm test:int` uses local Supabase (start it first with
// `pnpm exec supabase start`); `pnpm test:int:pglite` uses in-process Postgres instead.
// Like the unit tests, they run in UTC.
process.env.TZ = "UTC";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": root,
      "server-only": fileURLToPath(
        new URL("./tests/support/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { KNIT_TEST_DB: mode === "pglite" ? "pglite" : "supabase" },
  },
}));
