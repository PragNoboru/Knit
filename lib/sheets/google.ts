import { normaliseKey } from "@/lib/domain/config";
import type { CellValue } from "@/lib/domain/dates";
import type { SheetRow } from "@/lib/domain/rows";

import {
  createGoogleApi,
  type GoogleApi,
  type GoogleApiOptions,
  type GoogleRequestInit,
} from "./google-api";

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
 * batched per tracker; 429 and 5xx answers are retried with exponential backoff and jitter
 * (google-api.ts). Tabs are addressed by sheetId; their current title is looked up for A1
 * ranges, so renaming a tab breaks nothing.
 *
 * Quotas (7.4: "stay well below them"): every call shares the service account's per-minute
 * read quota, so a tab's title is looked up once and reused for a few seconds by the calls of
 * the same job, and range-fed dropdowns are read in one batch. A reused title that no longer
 * names the tab (renamed meanwhile) is looked up again, once.
 */

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
/** Data rows sampled for formula and dropdown detection (7.4: "a sample of data rows"). */
const STRUCTURE_SAMPLE_ROWS = 300;
/** How long a looked-up tab title is reused, so one job does not list the tabs per call. */
const TAB_CACHE_MS = 15_000;

export interface GoogleSheetOptions extends GoogleApiOptions {
  folderId: string;
  /** Clock for the tab title cache, so tests can control it. */
  now?: () => number;
}

type Json = Record<string, unknown>;

interface GridCell {
  userEnteredValue?: { formulaValue?: string } & Json;
  effectiveValue?: Json;
  formattedValue?: string;
  dataValidation?: {
    condition?: { type?: string; values?: { userEnteredValue?: string }[] };
  };
}

/** A reused tab title now names another tab (tabs renamed since it was looked up). */
class StaleTabTitle extends SheetError {
  constructor() {
    super("The tab title now names another tab", "api_error");
  }
}

function a1Title(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function cellText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * N6: a cell whose value comes from a formula. It holds one (userEnteredValue.formulaValue),
 * or it is filled by an array formula anchored in another cell: the Sheets API returns such a
 * cell with a value (effectiveValue, formattedValue) but no userEnteredValue.
 */
function isFormulaCell(cell: GridCell): boolean {
  if (cell.userEnteredValue) return Boolean(cell.userEnteredValue.formulaValue);
  return (
    cell.effectiveValue !== undefined || cellText(cell.formattedValue) !== ""
  );
}

/**
 * A plain A1 reference without a tab ($Z$2:$Z$8, Z2:Z8, Z:Z, 2:8). In a dropdown rule it means
 * the rule's own tab, while the Values API would read it from the first visible tab, so it gets
 * the tracker's tab name. Anything else (a tab-qualified range, a named range) is kept as is.
 */
const BARE_A1 =
  /^(\$?[A-Z]{1,3}\$?\d+(:\$?[A-Z]{1,3}\$?\d*)?|\$?[A-Z]{1,3}\$?\d*:\$?[A-Z]{1,3}\$?\d*|\$?\d+:\$?\d+)$/i;

/** The 0-based index of a row's last non-empty cell, or -1. */
function lastFilled(row: unknown[]): number {
  for (let i = row.length - 1; i >= 0; i -= 1)
    if (cellText(row[i]) !== "") return i;
  return -1;
}

export class GoogleSheetSource implements SheetSource {
  private readonly api: GoogleApi;
  private readonly now: () => number;
  private readonly tabCache = new Map<
    string,
    { at: number; tabs: Promise<TabInfo[]> }
  >();

  constructor(private readonly options: GoogleSheetOptions) {
    this.api = createGoogleApi(options);
    this.now = options.now ?? Date.now;
  }

  private request<T>(url: string, init: GoogleRequestInit = {}): Promise<T> {
    return this.api.request<T>(url, init);
  }

  private isCached(fileId: string): boolean {
    const hit = this.tabCache.get(fileId);
    return hit !== undefined && this.now() - hit.at < TAB_CACHE_MS;
  }

  private async tabTitle(ref: TabRef): Promise<string> {
    const tabs = this.isCached(ref.fileId)
      ? await this.tabCache.get(ref.fileId)!.tabs
      : await this.listTabs(ref.fileId);
    const tab = tabs.find((t) => t.sheetId === ref.sheetId);
    if (!tab)
      throw new SheetError(
        `No tab ${ref.sheetId} in ${ref.fileId}`,
        "tab_not_found",
      );
    return tab.title;
  }

  /**
   * Runs `work` with the tab's current title. When a reused title turns out to be stale (the
   * range cannot be parsed, 400, or it names another tab), the title is looked up again and
   * `work` runs once more: a 400 means Google applied nothing.
   */
  private async onTab<T>(
    ref: TabRef,
    work: (title: string) => Promise<T>,
  ): Promise<T> {
    const reused = this.isCached(ref.fileId);
    const title = await this.tabTitle(ref);
    try {
      return await work(title);
    } catch (error) {
      const stale =
        error instanceof StaleTabTitle ||
        (error instanceof SheetError && error.status === 400);
      if (!reused || !stale) throw error;
      this.tabCache.delete(ref.fileId);
      return work(await this.tabTitle(ref));
    }
  }

  private async values(
    fileId: string,
    range: string,
    render: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA",
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

  /**
   * Options of dropdowns fed from a range (Lists!A2:A8), in one batchGet. A range that cannot
   * be read gives null, never a guess; since one bad range fails the whole batch, the ranges
   * are then read one by one.
   */
  private async rangeOptions(
    fileId: string,
    title: string,
    sources: string[],
  ): Promise<(string[] | null)[]> {
    if (sources.length === 0) return [];
    const ranges = sources.map((source) => {
      const range = source.replace(/^=/, "").trim();
      return BARE_A1.test(range) ? `${a1Title(title)}!${range}` : range;
    });
    const options = (values: unknown[][] | undefined) =>
      (values ?? [])
        .flat()
        .map(cellText)
        .map((v) => v.trim())
        .filter((v) => v !== "");
    try {
      const params = new URLSearchParams({
        valueRenderOption: "FORMATTED_VALUE",
        majorDimension: "ROWS",
      });
      for (const range of ranges) params.append("ranges", range);
      const body = await this.request<{
        valueRanges?: { values?: unknown[][] }[];
      }>(`${SHEETS}/${fileId}/values:batchGet?${params}`);
      return ranges.map((_, i) => options(body.valueRanges?.[i]?.values));
    } catch {
      if (ranges.length === 1) return [null];
      return Promise.all(
        ranges.map(async (range) => {
          try {
            return options(await this.values(fileId, range, "FORMATTED_VALUE"));
          } catch {
            return null;
          }
        }),
      );
    }
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

  /** Always read afresh (the wizard, activation); the result is kept for tabTitle. */
  listTabs(fileId: string): Promise<TabInfo[]> {
    const tabs = this.fetchTabs(fileId);
    this.tabCache.set(fileId, { at: this.now(), tabs });
    tabs.catch(() => {
      if (this.tabCache.get(fileId)?.tabs === tabs)
        this.tabCache.delete(fileId);
    });
    return tabs;
  }

  private async fetchTabs(fileId: string): Promise<TabInfo[]> {
    const body = await this.request<{
      sheets?: {
        properties: {
          sheetId?: number;
          title: string;
          sheetType?: string;
          gridProperties?: { rowCount?: number; columnCount?: number };
        };
      }[];
    }>(
      `${SHEETS}/${fileId}?fields=${encodeURIComponent("sheets.properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount))")}`,
    );
    // 11 step 2: only a grid sheet can hold a tracker; a chart sheet (OBJECT) has no cells.
    return (body.sheets ?? [])
      .filter(({ properties: p }) => (p.sheetType ?? "GRID") === "GRID")
      .map(({ properties: p }) => ({
        sheetId: p.sheetId ?? 0,
        title: p.title,
        rowCount: p.gridProperties?.rowCount ?? 0,
        columnCount: p.gridProperties?.columnCount ?? 0,
      }));
  }

  async readTopRows(ref: TabRef, count: number): Promise<string[][]> {
    return this.onTab(ref, async (title) => {
      const rows = await this.values(
        ref.fileId,
        `${a1Title(title)}!1:${count}`,
        "FORMATTED_VALUE",
      );
      return rows.map((row) => row.map(cellText));
    });
  }

  async readStructure(ref: TabRef, headerRow: number): Promise<TabStructure> {
    return this.onTab(ref, async (title) => {
      const params = new URLSearchParams({
        ranges: `${a1Title(title)}!${headerRow}:${headerRow + STRUCTURE_SAMPLE_ROWS}`,
        includeGridData: "true",
        fields:
          "sheets(properties(sheetId),data(startRow,rowData(values(userEnteredValue,effectiveValue,formattedValue,dataValidation))))",
      });
      const body = await this.request<{
        sheets?: {
          properties?: { sheetId?: number };
          data?: { rowData?: { values?: GridCell[] }[] }[];
        }[];
      }>(`${SHEETS}/${ref.fileId}?${params}`);
      const sheet = body.sheets?.[0];
      if (sheet?.properties && (sheet.properties.sheetId ?? 0) !== ref.sheetId)
        throw new StaleTabTitle();
      const rows = sheet?.data?.[0]?.rowData ?? [];
      const headerCells = rows[0]?.values ?? [];
      const headers = headerCells.flatMap((cell, index) => {
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
      // An array formula anchored in the header cell ({"Status"; ARRAYFORMULA(...)}), or above
      // it, fills the whole column below, even where its sampled results are blank.
      headerCells.forEach((cell, index) => {
        const header = byIndex.get(index);
        if (header && isFormulaCell(cell))
          formulaColumns.add(header.normalised);
      });
      const validations: TabStructure["validations"] = {};
      const ranges = new Map<string, string>();
      for (const row of rows.slice(1)) {
        (row.values ?? []).forEach((cell, index) => {
          const header = byIndex.get(index);
          if (!header) return;
          if (isFormulaCell(cell)) formulaColumns.add(header.normalised);
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
      const options = await this.rangeOptions(ref.fileId, title, [
        ...ranges.values(),
      ]);
      [...ranges].forEach(([header, source], i) => {
        validations[header] = { options: options[i] ?? null, source };
      });

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
    });
  }

  async readRows(ref: TabRef, headerRow: number): Promise<SheetRow[]> {
    return this.onTab(ref, async (title) => {
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
        return header === ""
          ? []
          : [{ index, normalised: normaliseKey(header) }];
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
    });
  }

  async readColumn(ref: TabRef, headerRow: number, header: string) {
    return this.onTab(ref, async (title) => {
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
    });
  }

  async ensureKnitColumns(ref: TabRef, headerRow: number) {
    // The grid size must be current, so the tabs are listed afresh.
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

    // 11 step 9: the first empty columns after the last used header. Empty means in every row
    // from the header row down, formulas included (FORMULA shows a formula whose result is
    // blank), so an unlabelled column right of the headers is never taken over (invariant 6).
    const used = await this.values(
      ref.fileId,
      `${a1Title(tab.title)}!A${headerRow}:ZZZ`,
      "FORMULA",
    );
    const first =
      used.reduce(
        (last, row) => Math.max(last, lastFilled(row)),
        headers.reduce((last, h) => Math.max(last, h.index), -1),
      ) + 1;
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
    if (missing.includes(KNIT_ID_HEADER)) {
      const idIndex = first + missing.indexOf(KNIT_ID_HEADER);
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
    // The header text goes in the same batch, so the columns, the protection and the headers
    // are added together or not at all (a batchUpdate is atomic). The batch is never re-sent
    // after a 5xx: a re-run finds the headers and stops, or finds none and starts clean.
    requests.push({
      updateCells: {
        start: {
          sheetId: ref.sheetId,
          rowIndex: headerRow - 1,
          columnIndex: first,
        },
        rows: [
          {
            values: missing.map((name) => ({
              userEnteredValue: { stringValue: name },
            })),
          },
        ],
        fields: "userEnteredValue",
      },
    });
    try {
      await this.request(`${SHEETS}/${ref.fileId}:batchUpdate`, {
        method: "POST",
        body: { requests },
        idempotent: false,
      });
    } finally {
      // The grid changed: the next call looks the tabs up again.
      this.tabCache.delete(ref.fileId);
    }
    return { knitIdHeader: KNIT_ID_HEADER, knitNoteHeader: KNIT_NOTE_HEADER };
  }

  async writeCells(
    ref: TabRef,
    headerRow: number,
    cells: CellWrite[],
  ): Promise<void> {
    if (cells.length === 0) return;
    await this.onTab(ref, async (title) => {
      // The header row is read right before the write, so a column moved since the rows were
      // read is still written by its header (14: columns moved have no effect).
      const headers = await this.headerColumns(ref.fileId, title, headerRow);
      const letterOf = (header: string) => {
        const column = headers.find(
          (h) => h.normalised === normaliseKey(header),
        );
        if (!column)
          throw new SheetError(`No column "${header}"`, "header_not_found");
        return column.letter;
      };
      // 7.4: one batch per tracker, USER_ENTERED. Text gets a leading apostrophe so Sheets keeps
      // it as text (a status word or "Mon 28 Sep" is never turned into a date); dates go in as
      // dates. Fixed cells, so sending it twice gives the same result.
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
        idempotent: true,
      });
    });
  }
}

/** Whether a Drive file can become a tracker (7.4: native Google Sheets only). */
export function isNativeSheet(file: DriveFile): boolean {
  return file.mimeType === GOOGLE_SHEET_MIME;
}
