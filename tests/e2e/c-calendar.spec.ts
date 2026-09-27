import { expect, test } from "@playwright/test";

// PRD 12.4, 12.7 on Wed 30 Sep 2026: 28 and 29 Sep are closed with missed tasks.

test("the month starts on Monday, marks off days and missed days, and opens a day below", async ({
  page,
}) => {
  await page.goto("/calendar");
  await expect(
    page.getByRole("heading", { name: "September 2026" }),
  ).toBeVisible();
  const calendar = page.getByRole("region", { name: "Calendar" });
  await expect(calendar.getByText("Mon").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Sun 27 Sep, day off, Sunday/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Mon 28 Sep, \d+ tasks, missed tasks$/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /^Tue 29 Sep/ }).click();
  await expect(page).toHaveURL(/day=2026-09-29/);
  await expect(page.getByRole("heading", { level: 1 }).last()).toHaveText(
    /^Tue 29 Sep · 0 of \d+ done · \d+ spilled in$/,
  );
});

test("a closed day is read-only, with a lock", async ({ page }) => {
  await page.goto("/day/2026-09-28");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Mon 28 Sep · 0 of \d+ done$/,
  );
  await expect(page.getByLabel("Closed").first()).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("Not Done").first()).toBeVisible();
});

test("a later day can be pulled forward from the Day view", async ({
  page,
}) => {
  await page.goto("/day/2026-10-23");
  const control = page.getByRole("combobox", {
    name: "Status of Competitor review and geo",
  });
  await expect(control).toBeEnabled();
  await control.click();
  await page.getByRole("option", { name: "In Progress", exact: true }).click();
  await expect(control).toHaveText("In Progress");
  await page.goto("/");
  await expect(
    page
      .getByRole("region", { name: "Pulled forward" })
      .getByRole("link", { name: "Competitor review and geo" }),
  ).toBeVisible();
});

test("a past day before go-live had nothing scheduled", async ({ page }) => {
  await page.goto("/day/2026-09-25");
  await expect(
    page.getByText("Nothing was scheduled on this day."),
  ).toBeVisible();
});

test("an off day says so and offers the next working day", async ({ page }) => {
  await page.goto("/day/2026-09-27");
  await expect(
    page.getByText("Day off (Sunday). Nothing is due or spills here."),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Next working day, Mon 28 Sep" })
    .click();
  await expect(page).toHaveURL(/\/day\/2026-09-28$/);
});
