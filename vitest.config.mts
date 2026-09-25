import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Every test runs in UTC, so IST handling can never lean on the machine's
// own timezone (CLAUDE.md invariant 1, PRD 17). Set here, before the test
// workers start, so they inherit it; tests/unit/timezone.test.ts fails if
// this ever stops working.
process.env.TZ = "UTC";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
    include: ["tests/unit/**/*.test.ts"],
    pool: "forks",
  },
});
