import { test as setup } from "@playwright/test";

import { signIn, STATE } from "./support";

// Signs in once per user and keeps the session for the other flows.
setup("sign in as the admin and as a member", async ({ browser }) => {
  for (const who of ["admin", "member"] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, who);
    await context.storageState({ path: STATE[who] });
    await context.close();
  }
});
