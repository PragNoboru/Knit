import { expect, test, type Page } from "@playwright/test";

import { snap } from "./support";

// PRD 11.1, N72 to N75 (M9): the admin connects the example in the Knit Standard Tracker v2
// layout (fixtures/trackers/Knit_Standard_Tracker_v2_example.xlsx) with Use the standard setup.
// Maker is who does a task and is assigned it; Owner checks it and shows on the task. CI leaves
// the file unconnected (KNIT_SEED_TRACKERS in ci.yml), so it is under New sheet found; the
// flows run on Wed 30 Sep 2026 as the admin, whose aliases are Pragaman and P (seed-local).

const FILE = "Knit_Standard_Tracker_v2_example";

/** One of the preview's counts (11 step 8). */
const count = (page: Page, label: string) =>
  page
    .getByRole("region", { name: "Counts" })
    .locator("div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");

/** The value beside a label in the drawer's facts (12.6). */
const fact = (page: Page, label: string) =>
  page
    .getByRole("dialog")
    .locator(
      `xpath=.//dt[normalize-space()='${label}']/following-sibling::dd[1]`,
    );

test("the standard setup connects a v2 tab: the Maker gets the task, the Owner shows on it", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.goto("/admin/trackers");
  await page
    .getByRole("region", { name: "New sheet found" })
    .getByRole("listitem")
    .filter({ hasText: FILE })
    .getByRole("link", { name: "Set up" })
    .click();
  await page
    .getByRole("listitem")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Use this tab" })
    .click();

  // Step 3: row 1 holds the 15 v2 headers, and the offer names the version (N74).
  await expect(page).toHaveURL(/\/setup\/header$/);
  const offer = page.getByRole("region", {
    name: "This tab follows the Knit Standard Tracker v2.",
  });
  await offer.getByRole("button", { name: "Use the standard setup" }).click();

  // Step 6: every name is known. Owners are looked up only where Maker is blank, so the
  // Owner Riya on a row with a Maker raises nothing (N73).
  await expect(page).toHaveURL(/\/setup\/owners\?standard=applied$/);
  await expect(
    page.getByText(
      "Standard setup applied. Check the owners, then name, colour and go-live.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Every name is known.")).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).first().click();

  // The preset filled step 4: Maker does the task, Owner checks it. Looked at, not saved.
  await expect(page).toHaveURL(/\/setup\/details$/);
  const steps = page.getByRole("list", { name: "Steps" });
  await steps.getByRole("link", { name: /Map columns$/ }).click();
  await expect(page).toHaveURL(/\/setup\/columns$/);
  await expect(
    page.getByRole("combobox", { name: "Who does the task", exact: true }),
  ).toHaveValue("Maker");
  await expect(
    page.getByRole("combobox", { name: "Checking owner (optional)" }),
  ).toHaveValue("Owner");
  if (info.project.name === "desktop")
    await snap(page, "desktop", "wizard-standard-v2-columns");
  await steps.getByRole("link", { name: /Name, colour, go-live$/ }).click();

  // Step 7: name and go-live (the next working day, Thu 1 Oct).
  await expect(page).toHaveURL(/\/setup\/details$/);
  await page.getByLabel("Go-live date", { exact: true }).fill("2026-10-01");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Standard v2 · Example");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 8: nine rows have someone to do them; Creative makes NOB-08 and is not a user.
  await expect(page).toHaveURL(/\/setup\/preview$/);
  await expect(count(page, "Assigned to someone")).toHaveText("9");
  await expect(count(page, "Date ranges")).toHaveText("4");
  await expect(count(page, "Before go-live (history only)")).toHaveText("2");
  await expect(count(page, "Unmapped statuses")).toHaveText("None");
  await page.getByRole("link", { name: "Continue to activation" }).click();

  // Step 9: activate; NOB-02 (blank Maker, so its Owner's) is the open row before go-live.
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page).toHaveURL(/\/admin\/trackers\/[0-9a-f-]{36}\/backlog$/, {
    timeout: 60_000,
  });
  await page.getByRole("checkbox", { name: /Test the lead form/ }).check();
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("mark_done");
  await page.getByRole("button", { name: "Apply to selected" }).click();
  await expect(
    page.getByRole("region", { name: "Nothing to review" }),
  ).toBeVisible();

  // NOB-03: Owner Shlok, Maker Pragaman. It is on the admin's Thu 1 Oct, with its Owner.
  await page.goto("/day/2026-10-01");
  const budget = page.getByRole("listitem").filter({
    has: page.getByRole("link", { name: "Sign off the launch budget" }),
  });
  await expect(budget).toContainText("Owner: Shlok");
  if (info.project.name === "desktop")
    await snap(page, "desktop", "day-owner-line");

  // The drawer lists the Owner and the Maker (12.6, N75).
  await budget
    .getByRole("link", { name: "Sign off the launch budget" })
    .click();
  await expect(page).toHaveURL(/\?task=[0-9a-f-]{36}$/);
  await expect(fact(page, "Owner")).toHaveText("Shlok");
  await expect(fact(page, "Maker")).toHaveText("Pragaman");
  await page.keyboard.press("Escape");

  // NOB-08: Pragaman is only its Owner; Creative makes it, so it is not his (N72). The
  // Everyone toggle shows it, with its Owner.
  await page.goto("/tasks?q=Make%20the%20retargeting%20banners");
  await expect(page.getByText("No tasks match these filters.")).toBeVisible();
  await page.goto("/tasks?q=Make%20the%20retargeting%20banners&everyone=1");
  await expect(
    page.getByRole("listitem").filter({
      has: page.getByRole("link", { name: "Make the retargeting banners" }),
    }),
  ).toContainText("Owner: Pragaman");
});
