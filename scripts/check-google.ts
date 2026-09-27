// PRD 7.4, docs/RUNBOOK.md 2.1: checks the Google setup before the first deploy. Read only.
//
//   pnpm check:google
//
// Reads GOOGLE_SERVICE_ACCOUNT_JSON, KNIT_DRIVE_FOLDER_ID and KNIT_ARCHIVE_SHEET_ID from the
// environment or .env.local. It signs in as the service account, opens the Knit folder, lists
// its files, reads the tabs of every native Google Sheet, and checks the service account can
// edit each sheet and the Knit Archive (which must sit outside the folder). It writes nothing
// and prints only file and tab names: never cell contents, never the key.
import { existsSync } from "node:fs";

import { z } from "zod";

import { driveId, parseEnv, serviceAccountJson } from "@/lib/env-schema";
import { GoogleSheetSource, isNativeSheet } from "@/lib/sheets/google";
import { createGoogleApi } from "@/lib/sheets/google-api";

const DRIVE = "https://www.googleapis.com/drive/v3/files";

interface DriveMeta {
  name: string;
  mimeType: string;
  parents?: string[];
  capabilities?: { canEdit?: boolean };
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const env = parseEnv(
    z.object({
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
      KNIT_DRIVE_FOLDER_ID: driveId(),
      KNIT_ARCHIVE_SHEET_ID: driveId(),
    }),
    process.env,
    "check-google needs these environment variables",
  );
  const credentials = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = credentials.client_email;
  const api = createGoogleApi({ credentials, maxAttempts: 3 });
  const source = new GoogleSheetSource({
    folderId: env.KNIT_DRIVE_FOLDER_ID,
    credentials,
    maxAttempts: 3,
  });
  const problems: string[] = [];
  const ok = (message: string) => console.log(`ok    ${message}`);
  const fail = (message: string) => {
    problems.push(message);
    console.log(`FAIL  ${message}`);
  };
  const meta = (id: string) =>
    api.request<DriveMeta>(
      `${DRIVE}/${encodeURIComponent(id)}?fields=${encodeURIComponent("name,mimeType,parents,capabilities(canEdit)")}&supportsAllDrives=true`,
    );

  console.log(`Service account: ${email}\n`);

  // The Knit folder (RUNBOOK 2.1 step 4).
  try {
    const folder = await meta(env.KNIT_DRIVE_FOLDER_ID);
    if (folder.mimeType !== "application/vnd.google-apps.folder")
      fail(`KNIT_DRIVE_FOLDER_ID is "${folder.name}", which is not a folder`);
    else if (!folder.capabilities?.canEdit)
      fail(
        `The folder "${folder.name}" is shared with ${email}, but not as Editor`,
      );
    else ok(`Knit folder "${folder.name}" is shared as Editor`);
  } catch (error) {
    fail(
      `The Knit folder cannot be opened (${describe(error)}). Share it with ${email} as Editor.`,
    );
  }

  // Its files and every native sheet's tabs (10.1, 11 step 2).
  try {
    const files = await source.listFolder();
    if (files.length === 0) fail("The Knit folder is empty.");
    for (const file of files) {
      if (!isNativeSheet(file)) {
        fail(
          `"${file.name}" is not a Google Sheet: open it and use File > Save as Google Sheets, then remove the original`,
        );
        continue;
      }
      try {
        const [tabs, details] = await Promise.all([
          source.listTabs(file.id),
          meta(file.id),
        ]);
        const summary = tabs
          .map((t) => `${t.title} (${t.rowCount} rows)`)
          .join(", ");
        if (!details.capabilities?.canEdit)
          fail(`"${file.name}" can be read but not edited by ${email}`);
        else ok(`"${file.name}": ${summary}`);
      } catch (error) {
        fail(`"${file.name}" cannot be read (${describe(error)})`);
      }
    }
  } catch (error) {
    fail(`The Knit folder cannot be listed (${describe(error)})`);
  }

  // The Knit Archive (10.7, RUNBOOK 2.1 step 6).
  try {
    const archive = await meta(env.KNIT_ARCHIVE_SHEET_ID);
    if (archive.mimeType !== "application/vnd.google-apps.spreadsheet")
      fail(
        `KNIT_ARCHIVE_SHEET_ID is "${archive.name}", which is not a Google Sheet`,
      );
    else if (archive.parents?.includes(env.KNIT_DRIVE_FOLDER_ID))
      fail(
        `The Knit Archive "${archive.name}" is inside the Knit folder: move it out`,
      );
    else if (!archive.capabilities?.canEdit)
      fail(
        `The Knit Archive "${archive.name}" is not shared with ${email} as Editor`,
      );
    else ok(`Knit Archive "${archive.name}" is shared as Editor`);
  } catch (error) {
    fail(
      `The Knit Archive cannot be opened (${describe(error)}). Share it with ${email} as Editor.`,
    );
  }

  console.log(
    problems.length === 0
      ? "\nThe Google setup is ready."
      : `\n${problems.length} ${problems.length === 1 ? "problem" : "problems"} to fix.`,
  );
  if (problems.length > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(describe(error));
  process.exit(1);
});
