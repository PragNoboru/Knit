import { expect, test } from "@playwright/test";

import { seedPassword, USERS } from "./support";

// PRD 12.1, 9.3: signed-out visitors land on /login; sessions come only from Supabase Auth.
test.use({ storageState: { cookies: [], origins: [] } });

test("a signed-out visitor is sent to /login and kept where they were going", async ({
  page,
}) => {
  await page.goto("/calendar");
  await expect(page).toHaveURL(/\/login\?next=%2Fcalendar$/);
  await expect(page.getByRole("heading", { name: "Knit" })).toBeVisible();
});

test("a wrong password is refused in plain language", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS.admin);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "That email and password don't match.",
  );
});

test("signing in opens Today, and signing out ends the session", async ({
  page,
}) => {
  await page.goto("/login?next=%2Ftasks");
  await page.getByLabel("Email").fill(USERS.admin);
  await page.getByLabel("Password").fill(seedPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});
