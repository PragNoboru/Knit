import { expect, test, type Page } from "@playwright/test";

import { snap, STATE } from "./support";

// PRD N83 to N86 (M9): a member sends the admin a sheet from the Guide. In local sheet mode
// (N16) the example trackers are the Knit folder and their ids are their file names. CI has
// connected Filing Buddy Google Ads (KNIT_SEED_TRACKERS); Sapiens has only a Calendar tab; the
// v2 example is still unconnected here: g-standard-v2 connects it next, which ends the request.
// The day a request was sent is not asserted, since the database clock is real in CI.

const V2 = "Knit_Standard_Tracker_v2_example";
const sheetLink = (id: string) =>
  `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;
const MEMBER = "Shlok (local)";
const NOTE = "Brand Zeta, for the October launch";

async function sendSheet(page: Page, link: string, note = "") {
  const form = page.getByRole("form", { name: "Send a sheet to the admin" });
  await form.getByLabel("Link to your sheet").fill(link);
  await form.getByLabel("Note for the admin (optional)").fill(note);
  await form.getByRole("button", { name: "Check and send" }).click();
  // The button says Checking the sheet while it runs, then comes back.
  await expect(
    form.getByRole("button", { name: "Check and send" }),
  ).toBeEnabled({ timeout: 45_000 });
  return form;
}

test.describe("a member", () => {
  test.use({ storageState: STATE.member });

  test("sends a sheet to the admin from the Guide", async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.goto("/guide#new-tracker");
    const form = page.getByRole("form", { name: "Send a sheet to the admin" });
    await expect(form).toBeVisible();
    if (info.project.name === "desktop")
      await snap(page, "desktop", "guide-send-a-sheet");

    await sendSheet(page, "https://example.com/my-sheet");
    await expect(form.getByRole("alert")).toHaveText(
      "Paste the link of a Google Sheet. It starts with https://docs.google.com/spreadsheets/d/",
    );

    // Already a tracker: answered from the database, without Google or the limit.
    await sendSheet(page, sheetLink("Filing_Buddy_Google_Ads_Tracker"));
    await expect(form.getByRole("alert")).toHaveText(
      "This sheet is already a tracker in Knit.",
    );

    await sendSheet(page, sheetLink("Sapiens_Example_Tracker"));
    await expect(form.getByRole("alert")).toHaveText(
      "This sheet has no Tasks tab. Keep the template's Tasks tab and its name.",
    );

    await sendSheet(page, sheetLink(V2), NOTE);
    const sent = form.getByRole("status");
    await expect(sent).toContainText("Sent to the admin.");
    await expect(sent).toContainText(
      `${V2}: 10 tasks, in the Knit Standard Tracker v2 layout.`,
    );
    // The fields clear once the sheet is sent.
    await expect(form.getByLabel("Link to your sheet")).toHaveValue("");
    if (info.project.name === "desktop")
      await snap(page, "desktop", "guide-sheet-sent");

    const mine = page.getByRole("region", { name: "Your requests" });
    await expect(
      mine.getByRole("listitem").filter({ hasText: V2 }),
    ).toContainText("Waiting for the admin");

    await sendSheet(page, sheetLink(V2));
    await expect(form.getByRole("alert")).toHaveText(
      "This sheet has already been sent to the admin.",
    );
  });
});

test("the admin sees New tracker requested and Requested by", async ({
  page,
}) => {
  await page.goto("/admin/attention");
  const knit = page.getByRole("region", { name: "Knit" });
  await expect(
    knit.getByRole("heading", { name: /New tracker requested/ }),
  ).toBeVisible();
  const item = knit.getByRole("listitem").filter({ hasText: V2 });
  await expect(item).toContainText(
    `${MEMBER} asks to connect "${V2}": 10 tasks, in the Knit Standard Tracker v2 layout.`,
  );
  await expect(item).toContainText(`Note: "${NOTE}"`);
  await expect(item.getByRole("link", { name: "Set up" })).toHaveAttribute(
    "href",
    `/admin/trackers/new/${V2}`,
  );
  await expect(
    item.getByRole("link", { name: "Open the sheet" }),
  ).toHaveAttribute(
    "href",
    `https://docs.google.com/spreadsheets/d/${V2}/edit`,
  );

  await page.goto("/admin/trackers");
  await expect(
    page
      .getByRole("region", { name: "New sheet found" })
      .getByRole("listitem")
      .filter({ hasText: V2 }),
  ).toContainText(`Requested by ${MEMBER}`);
});
