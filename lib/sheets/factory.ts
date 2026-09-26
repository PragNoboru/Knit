import "server-only";

import type { ServerEnv } from "@/lib/env";

import { GoogleSheetSource } from "./google";
import type { SheetSource } from "./types";

/** The SheetSource for this environment (PRD 7.5, 18.3). */
export async function sheetSourceFor(env: ServerEnv): Promise<SheetSource> {
  if (env.KNIT_SHEET_SOURCE === "google") {
    return new GoogleSheetSource({
      folderId: env.KNIT_DRIVE_FOLDER_ID,
      credentials: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    });
  }
  const { getLocalSheetSource } = await import("./local");
  return getLocalSheetSource();
}
