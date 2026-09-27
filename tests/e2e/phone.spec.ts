import { expect, test } from "@playwright/test";

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
