import "server-only";

import type { ServerEnv } from "@/lib/env";

import { GoogleSheetSource } from "./google";
import type { SheetSource } from "./types";

/**
 * The SheetSource for this environment (PRD 7.5, 18.3). `deadline` (epoch ms) stops every
 * Google request made through it at that time (N88); the local source reads files on disk and
 * ignores it.
 */
export async function sheetSourceFor(
  env: ServerEnv,
  options: { deadline?: number } = {},
): Promise<SheetSource> {
  if (env.KNIT_SHEET_SOURCE === "google") {
    return new GoogleSheetSource({
      folderId: env.KNIT_DRIVE_FOLDER_ID,
      credentials: env.GOOGLE_SERVICE_ACCOUNT_JSON,
      ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
    });
  }
  const { getLocalSheetSource } = await import("./local");
  return getLocalSheetSource();
}
