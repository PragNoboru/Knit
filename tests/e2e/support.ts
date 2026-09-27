import { expect, type Page } from "@playwright/test";

/** Users made by scripts/seed-local.ts; the password is KNIT_SEED_PASSWORD. */
export const USERS = {
  admin: "admin@knit.test",
  member: "member@knit.test",
} as const;

export const STATE = {
  admin: "test-results/.auth/admin.json",
  member: "test-results/.auth/member.json",
} as const;

export function seedPassword(): string {
  const password = process.env.KNIT_SEED_PASSWORD;
  if (!password)
    throw new Error("Set KNIT_SEED_PASSWORD to the password seed-local used.");
  return password;
}

export async function signIn(page: Page, who: keyof typeof USERS) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who]);
  await page.getByLabel("Password").fill(seedPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** The status dropdown of a task row (StatusControl labels it by the task's title). */
export const statusOf = (page: Page, title: string) =>
  page.getByRole("combobox", { name: `Status of ${title}` });

export async function pickStatus(page: Page, title: string, label: string) {
  await statusOf(page, title).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

/** A full-page screenshot kept as a CI artifact (M7: 1280 px and 390 px). */
export async function snap(page: Page, project: string, name: string) {
  await page.screenshot({
    path: `test-results/screenshots/${project}/${name}.png`,
    fullPage: true,
  });
}
