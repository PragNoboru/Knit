import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createGoogleApi,
  type GoogleApiOptions,
} from "@/lib/sheets/google-api";
import type { LocalDate } from "@/lib/time";

/**
 * PRD 10.7: the Knit Archive, a Google Sheet outside the Knit folder with tabs `task_days` and
 * `events`. Closing day D replaces D's rows (deletes any already there, then appends), so a
 * re-run never duplicates them. It holds history even if Supabase is unavailable (14).
 */

export interface ArchiveRows {
  taskDays: unknown[][];
  events: unknown[][];
}

export interface ArchiveSink {
  replaceDay(day: LocalDate, rows: ArchiveRows): Promise<void>;
}

export const ARCHIVE_TABS = {
  taskDays: {
    title: "task_days",
    header: [
      "day",
      "task_day_id",
      "task_id",
      "tracker",
      "source_ref",
      "title",
      "status",
      "carried_status",
      "spill_index",
      "origin",
      "reason",
      "locked_at",
    ],
  },
  events: {
    title: "events",
    header: [
      "day",
      "event_id",
      "at",
      "task_id",
      "tracker",
      "origin",
      "field",
      "old_value",
      "new_value",
      "reason",
      "actor",
    ],
  },
} as const;

type TabKey = keyof typeof ARCHIVE_TABS;

const cell = (value: unknown) =>
  value === null || value === undefined ? "" : String(value);

/** In-memory archive for tests; also the local development archive (saved to a file). */
export class MemoryArchive implements ArchiveSink {
  constructor(
    readonly tabs: Record<TabKey, string[][]> = { taskDays: [], events: [] },
    private readonly onChange?: (tabs: Record<TabKey, string[][]>) => void,
  ) {}

  async replaceDay(day: LocalDate, rows: ArchiveRows): Promise<void> {
    for (const key of Object.keys(ARCHIVE_TABS) as TabKey[]) {
      this.tabs[key] = [
        ...this.tabs[key].filter((row) => row[0] !== day),
        ...rows[key].map((row) => row.map(cell)),
      ];
    }
    this.onChange?.(this.tabs);
  }
}

/** Local development (N16): .knit-local/archive.json. */
export function localArchive(root = process.cwd()): MemoryArchive {
  const file = path.join(root, ".knit-local", "archive.json");
  const tabs = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<TabKey, string[][]>)
    : { taskDays: [], events: [] };
  return new MemoryArchive(tabs, (current) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(current));
  });
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleArchive implements ArchiveSink {
  private readonly api;

  constructor(
    private readonly spreadsheetId: string,
    options: GoogleApiOptions,
  ) {
    this.api = createGoogleApi(options);
  }

  private async tabs(): Promise<Map<string, number>> {
    const body = await this.api.request<{
      sheets?: { properties: { sheetId: number; title: string } }[];
    }>(
      `${SHEETS}/${this.spreadsheetId}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`,
    );
    return new Map(
      (body.sheets ?? []).map((s) => [
        s.properties.title,
        s.properties.sheetId,
      ]),
    );
  }

  /** Creates the archive tabs, with their header rows, if they are missing. */
  private async ensureTabs(): Promise<Map<string, number>> {
    let tabs = await this.tabs();
    const missing = Object.values(ARCHIVE_TABS).filter(
      (t) => !tabs.has(t.title),
    );
    if (missing.length === 0) return tabs;
    await this.api.request(`${SHEETS}/${this.spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: {
        requests: missing.map((t) => ({
          addSheet: { properties: { title: t.title } },
        })),
      },
    });
    await this.api.request(
      `${SHEETS}/${this.spreadsheetId}/values:batchUpdate`,
      {
        method: "POST",
        body: {
          valueInputOption: "RAW",
          data: missing.map((t) => ({
            range: `'${t.title}'!A1`,
            values: [t.header],
          })),
        },
      },
    );
    tabs = await this.tabs();
    return tabs;
  }

  async replaceDay(day: LocalDate, rows: ArchiveRows): Promise<void> {
    const tabs = await this.ensureTabs();
    for (const key of Object.keys(ARCHIVE_TABS) as TabKey[]) {
      const { title } = ARCHIVE_TABS[key];
      const sheetId = tabs.get(title)!;
      const column = await this.api.request<{ values?: unknown[][] }>(
        `${SHEETS}/${this.spreadsheetId}/values/${encodeURIComponent(`'${title}'!A:A`)}`,
      );
      // Rows already holding day D, deleted bottom-up so indexes stay valid.
      const indexes = (column.values ?? [])
        .map((row, index) => (cell(row[0]) === day ? index : -1))
        .filter((index) => index > 0)
        .reverse();
      if (indexes.length > 0) {
        await this.api.request(`${SHEETS}/${this.spreadsheetId}:batchUpdate`, {
          method: "POST",
          body: {
            requests: indexes.map((index) => ({
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: index,
                  endIndex: index + 1,
                },
              },
            })),
          },
        });
      }
      if (rows[key].length > 0) {
        const params = new URLSearchParams({
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
        });
        await this.api.request(
          `${SHEETS}/${this.spreadsheetId}/values/${encodeURIComponent(`'${title}'!A1`)}:append?${params}`,
          {
            method: "POST",
            body: { values: rows[key].map((row) => row.map(cell)) },
          },
        );
      }
    }
  }
}
