import { defineConfig, devices } from "@playwright/test";

/**
 * PRD 17, M7: end-to-end flows against a running Knit on a local Supabase in local sheet mode
 * (N16), seeded by `pnpm seed:local`. CI fixes Knit's clock at Mon 28 Sep 2026 (see
 * .github/workflows/ci.yml), which the flows assume.
 */

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;
const ADMIN = "test-results/.auth/admin.json";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results/output",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // The flows change shared data (statuses), so they run one at a time, in file order.
  fullyParallel: false,
  workers: 1,
  // No retries: a retried flow would start from the data its first attempt changed.
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /(auth\.setup|phone\.spec)\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
        storageState: ADMIN,
      },
    },
    {
      // 12.2: under 640 px rows become cards. The screenshots and the phone layout checks.
      name: "phone",
      dependencies: ["desktop"],
      testMatch: /(screens|phone)\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        storageState: ADMIN,
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  },
});
