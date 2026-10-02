import { expect, test, type Page } from "@playwright/test";

import { snap } from "./support";

// PRD 11.1, N64, N68, N69 (M9): the admin connects the example in the Knit Standard Tracker v1
// layout (fixtures/trackers/Knit_Standard_Tracker_v1_example.xlsx) with Use the standard
// setup. CI leaves it unconnected (KNIT_SEED_TRACKERS in ci.yml), so it is under New sheet
// found; the flows run on Wed 30 Sep 2026.

const FILE = "Knit_Standard_Tracker_v1_example";

/** One of the preview's counts (11 step 8). */
const count = (page: Page, label: string) =>
  page
    .getByRole("region", { name: "Counts" })
    .locator("div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");

test("the standard setup connects a tab in the standard layout", async ({
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

  // Step 2: the Tasks tab (Summary, Lists and Guide are the template's other tabs).
  await page
    .getByRole("listitem")
    .filter({ has: page.getByText("Tasks", { exact: true }) })
    .getByRole("button", { name: "Use this tab" })
    .click();

  // Step 3: row 1 holds the 14 standard headers, so the standard setup is offered.
  await expect(page).toHaveURL(/\/setup\/header$/);
  const offer = page.getByRole("region", {
    name: "This tab follows the Knit Standard Tracker v1.",
  });
  await expect(
    offer.getByText(
      "Knit can fill in the columns, statuses and write-back words in one go. You then check owners, name, colour and go-live, and can still change any step.",
    ),
  ).toBeVisible();
  await offer.getByRole("button", { name: "Use the standard setup" }).click();

  // Step 6: Owners and policies, with the notice. Riya is not a Knit user.
  await expect(page).toHaveURL(/\/setup\/owners\?standard=applied$/);
  await expect(
    page.getByText(
      "Standard setup applied. Check the owners, then name, colour and go-live.",
    ),
  ).toBeVisible();
  const riya = page
    .getByRole("region", { name: "Owner names Knit does not know" })
    .getByRole("listitem")
    .filter({ hasText: "Riya" });
  await riya
    .getByRole("combobox", { name: "Who is Riya" })
    .selectOption("non_user");
  await riya.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Every name is known.")).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).first().click();

  // The preset filled step 4: End date and the status write column. Looked at, not saved.
  await expect(page).toHaveURL(/\/setup\/details$/);
  const steps = page.getByRole("list", { name: "Steps" });
  await steps.getByRole("link", { name: /Map columns$/ }).click();
  await expect(page).toHaveURL(/\/setup\/columns$/);
  await expect(
    page.getByRole("combobox", { name: "End date (optional)" }),
  ).toHaveValue("End date");
  await expect(
    page.getByRole("combobox", { name: "Status (write)" }),
  ).toHaveValue("Status");
  await steps.getByRole("link", { name: /Name, colour, go-live$/ }).click();

  // Step 7: name and go-live (the next working day, Thu 1 Oct).
  await expect(page).toHaveURL(/\/setup\/details$/);
  await page.getByLabel("Go-live date", { exact: true }).fill("2026-10-01");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Standard · Example");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 8: four Date and End date ranges, two moved off an off day (Sun 18 Oct, Tue 20 Oct
  // Dussehra), the two rows of 28 and 29 Sep before go-live, every status mapped.
  await expect(page).toHaveURL(/\/setup\/preview$/);
  await expect(count(page, "Date ranges")).toHaveText("4");
  await expect(count(page, "Moved off an off day")).toHaveText("2");
  await expect(count(page, "Before go-live (history only)")).toHaveText("2");
  await expect(count(page, "Unmapped statuses")).toHaveText("None");
  if (info.project.name === "desktop")
    await snap(page, "desktop", "wizard-standard");
  await page.getByRole("link", { name: "Continue to activation" }).click();

  // Step 9: activate; the open row of 29 Sep is in the backlog review.
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page).toHaveURL(/\/admin\/trackers\/[0-9a-f-]{36}\/backlog$/, {
    timeout: 60_000,
  });
  await page
    .getByRole("checkbox", {
      name: /Check the conversion tag on the thank-you page/,
    })
    .check();
  await page
    .getByRole("combobox", { name: "Action", exact: true })
    .selectOption("mark_done");
  await page.getByRole("button", { name: "Apply to selected" }).click();
  // It was the only open old row, so the review is now empty (6.11) and the form is gone.
  await expect(
    page.getByRole("region", { name: "Nothing to review" }),
  ).toBeVisible();

  // All Tasks shows the Date and End date window (12.5).
  await page.goto("/tasks?q=search%20campaigns");
  const row = page.getByRole("listitem").filter({
    has: page.getByRole("link", { name: "Build the search campaigns" }),
  });
  await expect(row).toContainText("Mon 5 Oct to Fri 9 Oct");
});
