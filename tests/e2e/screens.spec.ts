import { expect, test } from "@playwright/test";

import { snap, STATE } from "./support";

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

// N83, N85 (12.9): the member's Guide at its width, with the form showing a refusal and Your
// requests showing the request g-standard-v2 connected.
test.describe("a member's Guide", () => {
  test.use({ storageState: STATE.member });

  test("screenshot of Send a sheet to the admin and Your requests", async ({
    page,
  }, info) => {
    await page.goto("/guide#new-tracker");
    const form = page.getByRole("form", { name: "Send a sheet to the admin" });
    await form
      .getByLabel("Link to your sheet")
      .fill("https://example.com/my-sheet");
    await form.getByRole("button", { name: "Check and send" }).click();
    await expect(form.getByRole("alert")).toContainText(
      "Paste the link of a Google Sheet.",
    );
    await expect(
      page
        .getByRole("region", { name: "Your requests" })
        .getByRole("listitem")
        .first(),
    ).toContainText("Connected");
    await snap(page, info.project.name, "guide-requests");
  });
});
