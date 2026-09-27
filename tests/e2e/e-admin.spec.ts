import { expect, test, type Page } from "@playwright/test";

import { snap, STATE } from "./support";

// PRD 11, 12.8 (M8): the admin connects the Noboru example tracker through every step of the
// setup wizard, reviews its backlog, and uses the other admin screens.

// fixtures/trackers.config.json, "Noboru · CA Campaign".
const STATUS_MAP: Record<string, string> = {
  "": "yet_to_start",
  no: "yet_to_start",
  yes: "done",
  "not needed": "cancelled",
  moved: "cancelled",
};

async function mapStatuses(page: Page) {
  const selects = page.locator('select[name^="status:"]');
  const count = await selects.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const select = selects.nth(i);
    const key = (await select.getAttribute("name"))!.slice("status:".length);
    await select.selectOption(STATUS_MAP[key] ?? "yet_to_start");
  }
}

test("the wizard connects a new sheet end to end", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto("/admin/trackers");
  const found = page.getByRole("region", { name: "New sheet found" });
  const noboru = found
    .getByRole("listitem")
    .filter({ hasText: "Noboru_CA_Campaign_test_example" });
  await noboru.getByRole("link", { name: "Set up" }).click();

  // Step 2: the tab.
  await page
    .getByRole("listitem")
    .filter({ hasText: "Tasks" })
    .getByRole("button", { name: "Use this tab" })
    .click();

  // Step 3: the suggested header row.
  await expect(page).toHaveURL(/\/setup\/header$/);
  await expect(page.getByText("Knit suggests row 1.")).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 4: columns. The Status column holds formulas, so it cannot be a write target.
  await expect(page).toHaveURL(/\/setup\/columns$/);
  await expect(
    page.getByRole("combobox", { name: "Status (write)" }).locator("option", {
      hasText: "Status (formula, read-only)",
    }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Date (planned date)" })
    .selectOption("Date");
  await page
    .getByRole("combobox", { name: "Title", exact: true })
    .selectOption("Task");
  await page
    .getByRole("combobox", { name: "Status (read)" })
    .selectOption("Done");
  await page
    .getByRole("combobox", { name: "Status (write)" })
    .selectOption("Done");
  await page
    .getByRole("combobox", { name: "Owner", exact: true })
    .selectOption("Owner");
  await page
    .getByRole("combobox", { name: "Critical flag" })
    .selectOption("Critical path");
  await page.getByLabel("Critical when the cell says").fill("Yes");
  await page.getByLabel("Subtitle template (optional)").fill("{Type}");
  await page.getByRole("checkbox", { name: "Notes" }).check();
  if (info.project.name === "desktop")
    await snap(page, "desktop", "wizard-columns");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 5: statuses and write-back values.
  await expect(page).toHaveURL(/\/setup\/statuses$/);
  await mapStatuses(page);
  await page
    .getByRole("combobox", { name: "Yet to Start", exact: true })
    .selectOption("__clear__");
  await page
    .getByRole("combobox", { name: "In Progress", exact: true })
    .selectOption("__leave__");
  await page
    .getByRole("combobox", { name: "Blocked", exact: true })
    .selectOption("__leave__");
  await page
    .getByRole("combobox", { name: "Done", exact: true })
    .selectOption("Yes");
  await page
    .getByRole("combobox", { name: "Cancelled", exact: true })
    // The export has no Lists tab, so its dropdown cannot be read and only the words in use
    // (Yes, No) can be written back (11 step 5): Cancelled leaves the cell alone (N8).
    .selectOption("__leave__");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 6: owners and policies.
  await expect(page).toHaveURL(/\/setup\/owners$/);
  await page.getByRole("button", { name: "Save and continue" }).first().click();

  // Step 7: name, colour, go-live.
  await expect(page).toHaveURL(/\/setup\/details$/);
  await page.getByLabel("Name").fill("Noboru · CA Campaign");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 8: preview. Nothing is written yet.
  await expect(page).toHaveURL(/\/setup\/preview$/);
  await expect(page.getByText("Unmapped statuses")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Counts" }).getByText("None"),
  ).toBeVisible();
  if (info.project.name === "desktop")
    await snap(page, "desktop", "wizard-preview");
  await page.getByRole("link", { name: "Continue to activation" }).click();

  // Step 9: activate, then the backlog review (step 10) or the tracker.
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page).toHaveURL(
    /\/admin\/trackers\/[0-9a-f-]{36}(\/backlog)?$/,
    {
      timeout: 60_000,
    },
  );
  if (page.url().endsWith("/backlog")) {
    const first = page.locator('input[name="taskId"]').first();
    await first.check();
    await page.getByRole("button", { name: "Apply to selected" }).click();
    await expect(page.getByText(/^1 task updated\.$/)).toBeVisible();
  }

  await page.goto("/admin/trackers");
  const row = page
    .getByRole("region", { name: "Connected trackers" })
    .getByRole("row")
    .filter({ hasText: "Noboru · CA Campaign" });
  await expect(row).toContainText("Active");
  await expect(
    page
      .getByRole("region", { name: "New sheet found" })
      .getByText("Noboru_CA_Campaign_test_example"),
  ).toHaveCount(0);
});

test("the other admin screens", async ({ page }, info) => {
  const shoot = (name: string) =>
    info.project.name === "desktop" ? snap(page, "desktop", name) : undefined;

  await page.goto("/admin/sync");
  await expect(page.getByRole("region", { name: "Write-backs" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Day closes" }).getByText("Tue 29 Sep"),
  ).toBeVisible();
  await shoot("admin-sync");

  await page.goto("/admin/attention");
  await expect(
    page.getByRole("heading", { name: "Needs Attention" }),
  ).toBeVisible();
  await shoot("admin-attention");

  await page.goto("/admin/people");
  await page.getByLabel("Name", { exact: true }).fill("Asha");
  await page.getByLabel("Email").fill("asha@knit.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-password");
  await page.getByLabel("Name in trackers").fill("Asha");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("Created asha@knit.test.")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Users" })
      .getByRole("cell", { name: "Asha", exact: true }),
  ).toBeVisible();
  await shoot("admin-people");

  await page.goto("/admin/holidays");
  await expect(page.getByRole("cell", { name: "Dussehra" })).toBeVisible();
  await page.getByLabel("Date").fill("2026-12-24");
  await page.getByLabel("Name").fill("Office closed");
  await page.getByRole("button", { name: "Save holiday" }).click();
  await expect(page.getByText("Saved Office closed.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Office closed" })).toBeVisible();
  await shoot("admin-holidays");
});

test.describe("a member", () => {
  test.use({ storageState: STATE.member });

  test("cannot open the admin screens", async ({ page }) => {
    // The page streams (loading.tsx), so the not-found page comes with status 200.
    await page.goto("/admin/trackers");
    await expect(page.getByText("This page could not be found.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(
      0,
    );
  });
});
