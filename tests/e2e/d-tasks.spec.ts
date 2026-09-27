import { expect, test } from "@playwright/test";

import { STATE } from "./support";

// PRD 12.5, N3: All Tasks, and what a member sees.

test("All Tasks searches titles and pages through the list", async ({
  page,
}) => {
  await page.goto("/tasks");
  await expect(page.getByText(/^\d+ tasks · page 1 of \d+$/)).toBeVisible();
  await page.getByLabel("Search titles").fill("negative");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=negative/);
  await expect(
    page.getByRole("link", { name: "Create the seven shared negative lists" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Account assets" })).toHaveCount(
    0,
  );
});

test.describe("a member", () => {
  test.use({ storageState: STATE.member });

  test("sees no Admin link and no Everyone toggle", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "All Tasks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.goto("/tasks");
    await expect(page.getByLabel("Everyone")).toHaveCount(0);
    await expect(
      page.getByRole("link", {
        name: "Remove the Rs 5,999 menu item sitewide",
      }),
    ).toHaveCount(0);
  });
});
