import { expect, test } from "@playwright/test";

import { snap, STATE } from "./support";

// PRD 12.2: under 640 px, rows are stacked cards with the status control full width.

test("rows are cards with a full-width status control", async ({ page }) => {
  await page.goto("/");
  const control = page.getByRole("combobox", { name: /^Status of / }).first();
  await expect(control).toBeVisible();
  const width = page.viewportSize()!.width;
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThan(width * 0.7);
  await expect(
    page.getByRole("link", { name: "Open in sheet" }).first(),
  ).toBeVisible();
});

// PRD 12.9 (N77, N78): the Guide at 390 px, from the Account menu. The desktop project runs
// first (h-guide.spec.ts saved the template link), so the member sees Get the tracker template.
test.describe("a member on a phone", () => {
  test.use({ storageState: STATE.member });

  test("opens the Guide from the Account menu, with no sideways scroll", async ({
    page,
  }, info) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Guide" }).click();
    await expect(page).toHaveURL(/\/guide$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Guide" }),
    ).toBeVisible();
    const get = page.getByRole("link", { name: "Get the tracker template" });
    await get.scrollIntoViewIfNeeded();
    await expect(get).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "For the admin" }),
    ).toHaveCount(0);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await snap(page, info.project.name, "guide-member");
  });
});
