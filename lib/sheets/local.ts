import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MemorySheetSource, type MemoryFile } from "./memory";

/**
 * PRD 18.3, N16: local development without Google. The example trackers in fixtures/trackers
 * act as the Knit folder; every write is saved to .knit-local/sheets.json, so a status pushed
 * from Knit is still there after a restart. Delete that file to start again from the fixtures.
 */

const FOLDER = ".knit-local";
const FILE = "sheets.json";

const globalCache = globalThis as unknown as {
  __knitLocalSheets?: Promise<MemorySheetSource>;
};

async function load(root: string): Promise<MemorySheetSource> {
  const folder = path.join(root, FOLDER);
  const file = path.join(folder, FILE);
  let files: MemoryFile[];
  if (existsSync(file)) {
    files = JSON.parse(readFileSync(file, "utf8")) as MemoryFile[];
  } else {
    // Loaded lazily: SheetJS is only needed here and in tests.
    const { loadXlsxFolder } = await import("./xlsx");
    files = loadXlsxFolder(path.join(root, "fixtures", "trackers"));
  }
  const save = (current: MemoryFile[]) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, JSON.stringify(current));
  };
  save(files);
  return new MemorySheetSource(files, { onChange: save });
}

/** One shared source per server process. */
export function getLocalSheetSource(
  root = process.cwd(),
): Promise<MemorySheetSource> {
  globalCache.__knitLocalSheets ??= load(root);
  return globalCache.__knitLocalSheets;
}
