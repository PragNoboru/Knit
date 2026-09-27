import { expect, test } from "@playwright/test";

import { snap } from "./support";

// M7: screenshots of every screen at 1280 px (desktop) and 390 px (phone), kept as CI
// artifacts for review.

test("screenshots", async ({ page }, info) => {
  const project = info.project.name;
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await snap(page, project, "today");

  await page.getByRole("link", { name: "Account assets" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await snap(page, project, "drawer");
  await page.keyboard.press("Escape");

  await page.goto("/calendar?month=2026-10&day=2026-10-02");
  await expect(
    page.getByRole("heading", { name: "October 2026" }),
  ).toBeVisible();
  await snap(page, project, "calendar");

  await page.goto("/day/2026-09-29");
  await snap(page, project, "day");

  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "All Tasks" })).toBeVisible();
  await snap(page, project, "all-tasks");
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("screenshot of the sign-in page", async ({ page }, info) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await snap(page, info.project.name, "login");
  });
});
