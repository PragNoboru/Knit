import { JWT } from "google-auth-library";

import { normaliseKey } from "@/lib/domain/config";
import type { CellValue } from "@/lib/domain/dates";
import type { SheetRow } from "@/lib/domain/rows";

import {
  columnLetter,
  GOOGLE_SHEET_MIME,
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  SheetError,
  type CellWrite,
  type ColumnInfo,
  type DriveFile,
  type SheetSource,
  type TabInfo,
  type TabRef,
  type TabStructure,
} from "./types";

/**
 * PRD 7.4: Google Sheets API v4 and Drive API v3 through the service account. Requests are
 * batched per tracker; 429 and 5xx answers are retried with exponential backoff and jitter.
 * Tabs are addressed by sheetId; their current title is looked up for A1 ranges, so renaming
 * a tab breaks nothing.
 */

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
];

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
/** Data rows sampled for formula and dropdown detection (7.4: "a sample of data rows"). */
const STRUCTURE_SAMPLE_ROWS = 300;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface GoogleSheetOptions {
  folderId: string;
  /** The service account key (validated by lib/env.ts). */
  credentials?: { client_email: string; private_key: string };
  /** Replaces the service-account token, for tests. */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

type Json = Record<string, unknown>;

interface GridCell {
  userEnteredValue?: { formulaValue?: string };
  formattedValue?: string;
  dataValidation?: {
    condition?: { type?: string; values?: { userEnteredValue?: string }[] };
  };
}

function a1Title(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function cellText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

export class GoogleSheetSource implements SheetSource {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly getToken: () => Promise<string>;

  constructor(private readonly options: GoogleSheetOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (options.getToken) {
      this.getToken = options.getToken;
    } else {
      if (!options.credentials)
        throw new Error("GoogleSheetSource needs credentials");
      const jwt = new JWT({
        email: options.credentials.client_email,
        key: options.credentials.private_key,
        scopes: GOOGLE_SCOPES,
      });
      this.getToken = async () => {
        const { token } = await jwt.getAccessToken();
        if (!token)
          throw new SheetError("Google returned no access token", "api_error");
        return token;
      };
    }
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private async request<T>(
    url: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const attempts = this.options.maxAttempts ?? 5;
    for (let attempt = 1; ; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${await this.getToken()}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 404) {
        throw new SheetError(
          `Not found: ${new URL(url).pathname}`,
          "file_not_found",
        );
      }
      if (!RETRYABLE.has(response.status) || attempt >= attempts) {
        // Never log or return sheet content: only the status and Google's error reason.
        let reason = "";
        try {
          const body = (await response.json()) as {
            error?: { status?: string; message?: string };
          };
          reason = body.error?.status ?? "";
        } catch {
          reason = "";
        }
        throw new SheetError(
          `Google API ${response.status} ${reason}`.trim(),
          "api_error",
        );
      }
      const backoff = 500 * 2 ** (attempt - 1);
      await this.sleep(backoff + Math.floor(Math.random() * backoff));
    }
  }

  private async tabTitle(ref: TabRef): Promise<string> {
    const tab = (await this.listTabs(ref.fileId)).find(
      (t) => t.sheetId === ref.sheetId,
    );
    if (!tab)
      throw new SheetError(
        `No tab ${ref.sheetId} in ${ref.fileId}`,
        "tab_not_found",
      );
    return tab.title;
  }

  private async values(
    fileId: string,
    range: string,
    render: "FORMATTED_VALUE" | "UNFORMATTED_VALUE",
  ): Promise<unknown[][]> {
    const params = new URLSearchParams({
      valueRenderOption: render,
      dateTimeRenderOption: "SERIAL_NUMBER",
      majorDimension: "ROWS",
    });
    const body = await this.request<{ values?: unknown[][] }>(
      `${SHEETS}/${fileId}/values/${encodeURIComponent(range)}?${params}`,
    );
    return body.values ?? [];
  }

  private async headerColumns(
    fileId: string,
    title: string,
    headerRow: number,
  ): Promise<ColumnInfo[]> {
    const [row = []] = await this.values(
      fileId,
      `${a1Title(title)}!${headerRow}:${headerRow}`,
      "FORMATTED_VALUE",
    );
    return row.flatMap((value, index) => {
      const header = cellText(value).trim();
      return header === ""
        ? []
        : [
            {
              index,
              letter: columnLetter(index),
              header,
              normalised: normaliseKey(header),
            },
          ];
    });
  }

  private async column(
    fileId: string,
    title: string,
    headerRow: number,
    header: string,
  ): Promise<ColumnInfo> {
    const column = (await this.headerColumns(fileId, title, headerRow)).find(
      (h) => h.normalised === normaliseKey(header),
    );
    if (!column)
      throw new SheetError(`No column "${header}"`, "header_not_found");
    return column;
  }

  // ---- SheetSource ---------------------------------------------------------------------------

  async listFolder(): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${this.options.folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.request<{
        files?: DriveFile[];
        nextPageToken?: string;
      }>(`${DRIVE}?${params}`);
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getFileModifiedTime(fileId: string): Promise<string> {
    const file = await this.request<{ modifiedTime: string }>(
      `${DRIVE}/${fileId}?fields=modifiedTime&supportsAllDrives=true`,
    );
    return file.modifiedTime;
  }

  async listTabs(fileId: string): Promise<TabInfo[]> {
    const body = await this.request<{
      sheets?: {
        properties: {
          sheetId: number;
          title: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    }>(
      `${SHEETS}/${fileId}?fields=${encodeURIComponent("sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))")}`,
    );
    return (body.sheets ?? []).map(({ properties: p }) => ({
      sheetId: p.sheetId,
      title: p.title,
      rowCount: p.gridProperties?.rowCount ?? 0,
      columnCount: p.gridProperties?.columnCount ?? 0,
    }));
  }

  async readTopRows(ref: TabRef, count: number): Promise<string[][]> {
    const title = await this.tabTitle(ref);
    const rows = await this.values(
      ref.fileId,
      `${a1Title(title)}!1:${count}`,
      "FORMATTED_VALUE",
    );
    return rows.map((row) => row.map(cellText));
  }

  async readStructure(ref: TabRef, headerRow: number): Promise<TabStructure> {
    const title = await this.tabTitle(ref);
    const params = new URLSearchParams({
      ranges: `${a1Title(title)}!${headerRow}:${headerRow + STRUCTURE_SAMPLE_ROWS}`,
      includeGridData: "true",
      fields:
        "sheets(data(startRow,rowData(values(userEnteredValue,formattedValue,dataValidation))))",
    });
    const body = await this.request<{
      sheets?: { data?: { rowData?: { values?: GridCell[] }[] }[] }[];
    }>(`${SHEETS}/${ref.fileId}?${params}`);
    const rows = body.sheets?.[0]?.data?.[0]?.rowData ?? [];
    const headers = (rows[0]?.values ?? []).flatMap((cell, index) => {
      const header = cellText(cell.formattedValue).trim();
      return header === ""
        ? []
        : [
            {
              index,
              letter: columnLetter(index),
              header,
              normalised: normaliseKey(header),
            },
          ];
    });
    const byIndex = new Map(headers.map((h) => [h.index, h]));

    const formulaColumns = new Set<string>();
    const validations: TabStructure["validations"] = {};
    const ranges = new Map<string, string>();
    for (const row of rows.slice(1)) {
      (row.values ?? []).forEach((cell, index) => {
        const header = byIndex.get(index);
        if (!header) return;
        if (cell.userEnteredValue?.formulaValue)
          formulaColumns.add(header.normalised);
        const condition = cell.dataValidation?.condition;
        if (
          !condition ||
          validations[header.normalised] ||
          ranges.has(header.normalised)
        )
          return;
        const values = (condition.values ?? []).map(
          (v) => v.userEnteredValue ?? "",
        );
        if (condition.type === "ONE_OF_LIST") {
          validations[header.normalised] = {
            options: values.filter((v) => v !== ""),
            source: values.join(","),
          };
        } else if (condition.type === "ONE_OF_RANGE" && values[0]) {
          ranges.set(header.normalised, values[0]);
        }
      });
    }
    // Dropdowns fed from a range (Lists!A2:A8): read that range; unreadable means null, never a guess.
    for (const [header, source] of ranges) {
      let options: string[] | null = null;
      try {
        const values = await this.values(
          ref.fileId,
          source.replace(/^=/, ""),
          "FORMATTED_VALUE",
        );
        options = values
          .flat()
          .map(cellText)
          .map((v) => v.trim())
          .filter((v) => v !== "");
      } catch {
        options = null;
      }
      validations[header] = { options, source };
    }

    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const h of headers) {
      if (seen.has(h.normalised)) duplicates.add(h.normalised);
      seen.add(h.normalised);
    }
    return {
      headers,
      formulaColumns: [...formulaColumns],
      validations,
      duplicateHeaders: [...duplicates],
    };
  }

  async readRows(ref: TabRef, headerRow: number): Promise<SheetRow[]> {
    const title = await this.tabTitle(ref);
    const range = `${a1Title(title)}!A${headerRow}:ZZZ`;
    const params = (render: string) =>
      new URLSearchParams({
        ranges: range,
        valueRenderOption: render,
        dateTimeRenderOption: "SERIAL_NUMBER",
        majorDimension: "ROWS",
      });
    type Batch = { valueRanges?: { values?: unknown[][] }[] };
    // 7.4: read twice, so dates are exact (serials) and text is as displayed.
    const [raw, shown] = await Promise.all([
      this.request<Batch>(
        `${SHEETS}/${ref.fileId}/values:batchGet?${params("UNFORMATTED_VALUE")}`,
      ),
      this.request<Batch>(
        `${SHEETS}/${ref.fileId}/values:batchGet?${params("FORMATTED_VALUE")}`,
      ),
    ]);
    const rawRows = raw.valueRanges?.[0]?.values ?? [];
    const shownRows = shown.valueRanges?.[0]?.values ?? [];
    const headers = (shownRows[0] ?? []).flatMap((value, index) => {
      const header = cellText(value).trim();
      return header === "" ? [] : [{ index, normalised: normaliseKey(header) }];
    });

    const rows: SheetRow[] = [];
    for (let i = 1; i < shownRows.length; i += 1) {
      const rawRow = rawRows[i] ?? [];
      const shownRow = shownRows[i] ?? [];
      if (
        shownRow.every((v) => cellText(v) === "") &&
        rawRow.every((v) => cellText(v) === "")
      )
        continue;
      const cells: Record<string, CellValue> = {};
      for (const header of headers) {
        if (header.normalised in cells) continue;
        const value = rawRow[header.index];
        cells[header.normalised] = {
          value:
            typeof value === "number" || typeof value === "boolean"
              ? value
              : value === undefined || value === null || value === ""
                ? null
                : String(value),
          formatted: cellText(shownRow[header.index]),
        };
      }
      rows.push({ rowNumber: headerRow + i, cells });
    }
    return rows;
  }

  async readColumn(ref: TabRef, headerRow: number, header: string) {
    const title = await this.tabTitle(ref);
    const column = await this.column(ref.fileId, title, headerRow, header);
    const rows = await this.values(
      ref.fileId,
      `${a1Title(title)}!${column.letter}${headerRow + 1}:${column.letter}`,
      "FORMATTED_VALUE",
    );
    return rows.map((row, i) => ({
      row: headerRow + 1 + i,
      value: cellText(row[0]),
    }));
  }

  async ensureKnitColumns(ref: TabRef, headerRow: number) {
    const tab = (await this.listTabs(ref.fileId)).find(
      (t) => t.sheetId === ref.sheetId,
    );
    if (!tab) throw new SheetError(`No tab ${ref.sheetId}`, "tab_not_found");
    const headers = await this.headerColumns(ref.fileId, tab.title, headerRow);
    const has = (name: string) =>
      headers.find((h) => h.normalised === normaliseKey(name));
    const missing = [KNIT_ID_HEADER, KNIT_NOTE_HEADER].filter(
      (name) => !has(name),
    );
    if (missing.length === 0)
      return { knitIdHeader: KNIT_ID_HEADER, knitNoteHeader: KNIT_NOTE_HEADER };

    // 11 step 9: the first empty columns after the last used header, adding grid columns if needed.
    const first =
      headers.length === 0 ? 0 : Math.max(...headers.map((h) => h.index)) + 1;
    const needed = first + missing.length - tab.columnCount;
    const requests: Json[] = [];
    if (needed > 0) {
      requests.push({
        appendDimension: {
          sheetId: ref.sheetId,
          dimension: "COLUMNS",
          length: needed,
        },
      });
    }
    const idIndex = missing.includes(KNIT_ID_HEADER)
      ? first
      : has(KNIT_ID_HEADER)!.index;
    if (missing.includes(KNIT_ID_HEADER)) {
      requests.push(
        {
          updateDimensionProperties: {
            range: {
              sheetId: ref.sheetId,
              dimension: "COLUMNS",
              startIndex: idIndex,
              endIndex: idIndex + 1,
            },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser",
          },
        },
        {
          addProtectedRange: {
            protectedRange: {
              range: {
                sheetId: ref.sheetId,
                startColumnIndex: idIndex,
                endColumnIndex: idIndex + 1,
              },
              description: "Managed by Knit",
              warningOnly: true,
            },
          },
        },
      );
    }
    if (requests.length > 0) {
      await this.request(`${SHEETS}/${ref.fileId}:batchUpdate`, {
        method: "POST",
        body: { requests },
      });
    }
    await this.request(`${SHEETS}/${ref.fileId}/values:batchUpdate`, {
      method: "POST",
      body: {
        valueInputOption: "RAW",
        data: missing.map((name, i) => ({
          range: `${a1Title(tab.title)}!${columnLetter(first + i)}${headerRow}`,
          values: [[name]],
        })),
      },
    });
    return { knitIdHeader: KNIT_ID_HEADER, knitNoteHeader: KNIT_NOTE_HEADER };
  }

  async writeCells(
    ref: TabRef,
    headerRow: number,
    cells: CellWrite[],
  ): Promise<void> {
    if (cells.length === 0) return;
    const title = await this.tabTitle(ref);
    const headers = await this.headerColumns(ref.fileId, title, headerRow);
    const letterOf = (header: string) => {
      const column = headers.find((h) => h.normalised === normaliseKey(header));
      if (!column)
        throw new SheetError(`No column "${header}"`, "header_not_found");
      return column.letter;
    };
    // 7.4: one batch per tracker, USER_ENTERED. Text gets a leading apostrophe so Sheets keeps it
    // as text (a status word or "Mon 28 Sep" is never turned into a date); dates go in as dates.
    const data = cells.map((cell) => ({
      range: `${a1Title(title)}!${letterOf(cell.header)}${cell.row}`,
      values: [
        [
          cell.value === ""
            ? ""
            : cell.kind === "text"
              ? `'${cell.value}`
              : cell.value,
        ],
      ],
    }));
    await this.request(`${SHEETS}/${ref.fileId}/values:batchUpdate`, {
      method: "POST",
      body: { valueInputOption: "USER_ENTERED", data },
    });
  }
}

/** Whether a Drive file can become a tracker (7.4: native Google Sheets only). */
export function isNativeSheet(file: DriveFile): boolean {
  return file.mimeType === GOOGLE_SHEET_MIME;
}
