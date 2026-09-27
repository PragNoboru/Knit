import { expect, test } from "@playwright/test";

import { pickStatus, statusOf } from "./support";

// PRD 12.3 on Wed 30 Sep 2026. The example trackers went live on Mon 28 Sep and nobody
// touched them, so the tasks of 28 and 29 Sep spilled into today and 30 Sep's are due today.

test("Today shows the date, the counts, spillovers and the day's tasks", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Wed 30 Sep · 0 of \d+ done · \d+ spilled in$/,
  );
  const spillover = page.getByRole("region", { name: "Spillover" });
  const row = spillover
    .getByRole("listitem")
    .filter({ hasText: "Remove the Rs 5,999 menu item sitewide" });
  await expect(row.getByText("Spilled 2x · from Mon 28 Sep")).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Due today" })
      .getByRole("link", { name: "Publish the staged pages" }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "Open in sheet" }),
  ).toHaveAttribute("href", /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
});

test("a status change shows at once, syncs to the sheet, and stays after a reload", async ({
  page,
}) => {
  await page.goto("/");
  const title = "Create the seven shared negative lists";
  await pickStatus(page, title, "In Progress");
  await expect(statusOf(page, title)).toHaveText("In Progress");
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row.getByText("Syncing")).toBeVisible();
  await expect(row.getByText("Syncing")).toBeHidden({ timeout: 30_000 });
  await expect(row.getByText("Not saved to sheet")).toHaveCount(0);
  await page.reload();
  await expect(statusOf(page, title)).toHaveText("In Progress");
});

test("Done moves a task to Done today and counts it", async ({ page }) => {
  await page.goto("/");
  await pickStatus(page, "Confirm auto-tagging is ON", "Done");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Wed 30 Sep · 1 of \d+ done · \d+ spilled in$/,
  );
  await page.getByText("Done today").click();
  await expect(statusOf(page, "Confirm auto-tagging is ON")).toHaveText("Done");
});

test("Blocked needs a reason, which the row then shows", async ({ page }) => {
  await page.goto("/");
  await pickStatus(page, "Account assets", "Blocked");
  const dialog = page.getByRole("dialog", { name: "Why is it blocked?" });
  await expect(
    dialog.getByRole("button", { name: "Mark blocked" }),
  ).toBeDisabled();
  await dialog.getByLabel("Reason").fill("Waiting for the logo files");
  await dialog.getByRole("button", { name: "Mark blocked" }).click();
  await expect(
    page
      .getByRole("region", { name: "Blocked" })
      .getByText("Reason: Waiting for the logo files"),
  ).toBeVisible();
});

test("Cancelled asks for confirmation, and Back changes nothing", async ({
  page,
}) => {
  await page.goto("/");
  const title = "Attach negative lists";
  await pickStatus(page, title, "Cancelled");
  const dialog = page.getByRole("dialog", { name: "Cancel this task?" });
  await expect(dialog).toContainText("This removes it from all future days");
  await dialog.getByLabel("Reason").fill("Duplicate of G12");
  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog).toBeHidden();
  await expect(statusOf(page, title)).toHaveText("Yet to Start");
  // The reason typed before Back does not come back for the next question (D2).
  await pickStatus(page, title, "Blocked");
  const blocked = page.getByRole("dialog", { name: "Why is it blocked?" });
  await expect(blocked.getByLabel("Reason")).toHaveValue("");
  await blocked.getByRole("button", { name: "Back" }).click();
  await expect(statusOf(page, title)).toHaveText("Yet to Start");
});

test("a request that cannot reach the server shows inline and keeps the list", async ({
  page,
}) => {
  await page.goto("/");
  const title = "Attach negative lists";
  // The status change's server action never gets an answer (a dropped connection).
  await page.route("**/*", (route) =>
    route.request().method() === "POST" &&
    route.request().headers()["next-action"] !== undefined
      ? route.abort("internetdisconnected")
      : route.continue(),
  );
  await pickStatus(page, title, "In Progress");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Knit couldn't reach the server" }),
  ).toBeVisible();
  await expect(statusOf(page, title)).toHaveText("Yet to Start");
  await expect(page.getByText("Knit can't load this page")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Wed 30 Sep/,
  );
  await page.unrouteAll();
});

test("the task drawer shows every day of a task and closes back to the list", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Remove the Rs 5,999 menu item sitewide" })
    .click();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  const drawer = page.getByRole("dialog");
  await expect(
    drawer.getByRole("heading", {
      name: "Remove the Rs 5,999 menu item sitewide",
    }),
  ).toBeVisible();
  const days = drawer.getByRole("region", { name: "Days" });
  for (const day of ["Mon 28 Sep", "Tue 29 Sep", "Wed 30 Sep"])
    await expect(days).toContainText(day);
  // 12.6: the admin can ask for a correction of a closed day.
  await expect(
    days.getByRole("button", { name: "Request correction" }),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
});

test("the tracker filter narrows the day to one tracker", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Trackers/ }).click();
  await page
    .getByRole("menuitemcheckbox", { name: "Filing Buddy · Meta Ads" })
    .click();
  await expect(page).toHaveURL(/tracker=/);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("link", { name: "Enable FB_2999_Leads_30Sep" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Account assets" })).toHaveCount(
    0,
  );
});
