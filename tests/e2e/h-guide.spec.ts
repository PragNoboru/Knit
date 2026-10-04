import { expect, test, type Page } from "@playwright/test";

import { snap, STATE } from "./support";

// PRD 12.9 (N77 to N80): the Guide, from the user menu. The admin saves the tracker template
// link; a member then sees Get the tracker template and none of the admin sections.

// Not a real file: any id of 20 to 128 letters, digits, "-" or "_" is a valid link (N80).
const SHEET =
  "https://docs.google.com/spreadsheets/d/1TemplateExampleId_abcdefghijklmnopqrstuvwx";

async function openGuideFromMenu(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Guide" }).click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Guide" }),
  ).toBeVisible();
}

test("the admin opens the Guide and saves the tracker template link", async ({
  page,
}, info) => {
  await openGuideFromMenu(page);
  await expect(
    page.getByRole("heading", { name: "For the admin" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();

  const field = page.getByLabel("Link to the tracker template");
  const save = page.getByRole("button", { name: "Save link" });

  // Not a Google Sheet: refused in plain language, nothing saved.
  await field.fill("https://example.com/my-template");
  await save.click();
  await expect(
    page.getByText(
      "Paste the link of a Google Sheet. It starts with https://docs.google.com/spreadsheets/d/",
    ),
  ).toBeVisible();

  await field.fill(`${SHEET}/edit#gid=0`);
  await save.click();
  await expect(page.getByText("Link saved.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Get the tracker template" }),
  ).toHaveAttribute("href", `${SHEET}/copy`);
  await snap(page, info.project.name, "guide-admin");
});

test.describe("a member", () => {
  test.use({ storageState: STATE.member });

  test("sees the Guide with the template link and no admin section", async ({
    page,
  }, info) => {
    await openGuideFromMenu(page);
    const get = page.getByRole("link", { name: "Get the tracker template" });
    await expect(get).toHaveAttribute("href", `${SHEET}/copy`);
    await expect(get).toHaveAttribute("target", "_blank");
    await expect(page.getByRole("heading", { name: "Statuses" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "For the admin" }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "People" })).toHaveCount(0);
    await expect(page.getByLabel("Link to the tracker template")).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Save link" })).toHaveCount(
      0,
    );
    // N83, N89: every person can send a sheet; only the admin sets passwords.
    await expect(
      page.getByRole("form", { name: "Send a sheet to the admin" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "The admin makes every login and sets every password. To change yours, ask the admin.",
      ),
    ).toBeVisible();
    await snap(page, info.project.name, "guide-member");
  });
});
