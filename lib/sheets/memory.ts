import { randomUUID } from "node:crypto";

import { normaliseKey } from "@/lib/domain/config";
import { fromSheetsSerial, formatDate, toSheetsSerial } from "@/lib/time";

import {
  columnLetter,
  GOOGLE_SHEET_MIME,
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  SheetError,
  type CellValue,
  type CellWrite,
  type ColumnInfo,
  type DriveFile,
  type SheetRow,
  type SheetSource,
  type TabInfo,
  type TabRef,
  type TabStructure,
} from "./types";

/**
 * An in-memory spreadsheet model implementing SheetSource (PRD 7.5). Tests use it to write,
 * move rows and race (17); the xlsx fixtures load into it read-only; local development keeps it
 * in a file. Test helpers below mutate it the way people edit sheets.
 */

export interface MemoryCell extends CellValue {
  /** The formula, or `{array <range>}` for a cell filled by an array formula (N6). */
  formula?: string;
}

export interface MemoryValidation {
  /** 0-based column; rows are 1-based sheet rows, inclusive. */
  column: number;
  fromRow: number;
  toRow: number;
  options: string[] | null;
  source: string;
}

export interface MemoryTab {
  sheetId: number;
  title: string;
  /** rows[0] is sheet row 1. */
  rows: MemoryCell[][];
  validations: MemoryValidation[];
  hiddenColumns: number[];
  protectedColumns: number[];
}

export interface MemoryFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  tabs: MemoryTab[];
}

const EMPTY: MemoryCell = { value: null, formatted: "" };

function isBlank(cell: MemoryCell | undefined): boolean {
  return (
    !cell || (cell.value === null && cell.formatted === "" && !cell.formula)
  );
}

function textOf(cell: MemoryCell | undefined): string {
  if (!cell) return "";
  if (cell.formatted !== "") return cell.formatted;
  return cell.value === null ? "" : String(cell.value);
}

export interface MemorySheetOptions {
  readOnly?: boolean;
  /** Called after every change, for file-backed local development. */
  onChange?: (files: MemoryFile[]) => void | Promise<void>;
  /** Clock for modifiedTime, so tests can control it. */
  now?: () => Date;
}

export class MemorySheetSource implements SheetSource {
  private tick = 0;

  constructor(
    readonly files: MemoryFile[],
    private readonly options: MemorySheetOptions = {},
  ) {}

  // ---- SheetSource ---------------------------------------------------------------------------

  async listFolder(): Promise<DriveFile[]> {
    return this.files.map(({ id, name, mimeType, modifiedTime }) => ({
      id,
      name,
      mimeType,
      modifiedTime,
    }));
  }

  async getFileModifiedTime(fileId: string): Promise<string> {
    return this.file(fileId).modifiedTime;
  }

  /** Every tab is a grid, and its grid is exactly the rows and columns it stores (TabInfo). */
  async listTabs(fileId: string): Promise<TabInfo[]> {
    return this.file(fileId).tabs.map((tab) => ({
      sheetId: tab.sheetId,
      title: tab.title,
      rowCount: tab.rows.length,
      columnCount: Math.max(0, ...tab.rows.map((r) => r.length)),
    }));
  }

  async readTopRows(ref: TabRef, count: number): Promise<string[][]> {
    return this.tab(ref)
      .rows.slice(0, count)
      .map((row) => row.map(textOf));
  }

  async readStructure(ref: TabRef, headerRow: number): Promise<TabStructure> {
    const tab = this.tab(ref);
    const headers = this.headers(tab, headerRow);
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const h of headers) {
      if (seen.has(h.normalised)) duplicates.add(h.normalised);
      seen.add(h.normalised);
    }
    // N6, as GoogleSheetSource: a data cell with a formula, or a formula in the header cell
    // itself (an array formula anchored there fills the column below).
    const formulaColumns = new Set<string>();
    for (const row of tab.rows.slice(headerRow - 1)) {
      row.forEach((cell, index) => {
        const header = headers.find((h) => h.index === index);
        if (cell?.formula && header) formulaColumns.add(header.normalised);
      });
    }
    const validations: TabStructure["validations"] = {};
    for (const rule of tab.validations) {
      const header = headers.find((h) => h.index === rule.column);
      if (header && rule.toRow > headerRow && !validations[header.normalised]) {
        validations[header.normalised] = {
          options: rule.options,
          source: rule.source,
        };
      }
    }
    return {
      headers,
      formulaColumns: [...formulaColumns],
      validations,
      duplicateHeaders: [...duplicates],
    };
  }

  async readRows(ref: TabRef, headerRow: number): Promise<SheetRow[]> {
    const tab = this.tab(ref);
    const headers = this.headers(tab, headerRow);
    const rows: SheetRow[] = [];
    tab.rows.slice(headerRow).forEach((row, offset) => {
      if (row.every(isBlank)) return;
      const cells: Record<string, CellValue> = {};
      for (const header of headers) {
        if (header.normalised in cells) continue; // first column wins for duplicated headers
        const cell = row[header.index] ?? EMPTY;
        cells[header.normalised] = {
          value: cell.value,
          formatted: cell.formatted,
        };
      }
      rows.push({ rowNumber: headerRow + offset + 1, cells });
    });
    return rows;
  }

  async readColumn(ref: TabRef, headerRow: number, header: string) {
    const tab = this.tab(ref);
    const column = this.column(tab, headerRow, header);
    return tab.rows.slice(headerRow).map((row, offset) => ({
      row: headerRow + offset + 1,
      value: textOf(row[column.index]),
    }));
  }

  async ensureKnitColumns(ref: TabRef, headerRow: number) {
    this.assertWritable();
    const tab = this.tab(ref);
    const headers = this.headers(tab, headerRow);
    const missing = [KNIT_ID_HEADER, KNIT_NOTE_HEADER].filter(
      (name) => !headers.some((h) => h.normalised === normaliseKey(name)),
    );
    if (missing.length === 0)
      return { knitIdHeader: KNIT_ID_HEADER, knitNoteHeader: KNIT_NOTE_HEADER };
    // 11 step 9, as GoogleSheetSource: the first columns after the last used header that are
    // empty in every row from the header row down (a formula counts as used), so no cell of
    // the tracker is ever overwritten.
    let next =
      tab.rows.slice(headerRow - 1).reduce(
        (last, row) =>
          Math.max(
            last,
            row.findLastIndex((c) => !isBlank(c)),
          ),
        headers.reduce((last, h) => Math.max(last, h.index), -1),
      ) + 1;
    const headerCells = this.rowAt(tab, headerRow);
    for (const name of missing) {
      headerCells[next] = { value: name, formatted: name };
      if (name === KNIT_ID_HEADER) {
        tab.hiddenColumns.push(next);
        tab.protectedColumns.push(next);
      }
      next += 1;
    }
    await this.changed(ref.fileId);
    return { knitIdHeader: KNIT_ID_HEADER, knitNoteHeader: KNIT_NOTE_HEADER };
  }

  async writeCells(
    ref: TabRef,
    headerRow: number,
    cells: CellWrite[],
  ): Promise<void> {
    this.assertWritable();
    const tab = this.tab(ref);
    for (const write of cells) {
      const column = this.column(tab, headerRow, write.header);
      const row = this.rowAt(tab, write.row);
      if (write.value === "")
        row[column.index] = { value: null, formatted: "" };
      else if (write.kind === "date") {
        row[column.index] = {
          value: toSheetsSerial(write.value),
          formatted: formatDate(write.value, "dd-MMM-yyyy"),
        };
      } else row[column.index] = { value: write.value, formatted: write.value };
    }
    await this.changed(ref.fileId);
  }

  // ---- Helpers -------------------------------------------------------------------------------

  file(fileId: string): MemoryFile {
    const file = this.files.find((f) => f.id === fileId);
    if (!file) throw new SheetError(`No file ${fileId}`, "file_not_found");
    return file;
  }

  tab(ref: TabRef): MemoryTab {
    const tab = this.file(ref.fileId).tabs.find(
      (t) => t.sheetId === ref.sheetId,
    );
    if (!tab)
      throw new SheetError(
        `No tab ${ref.sheetId} in ${ref.fileId}`,
        "tab_not_found",
      );
    return tab;
  }

  headers(tab: MemoryTab, headerRow: number): ColumnInfo[] {
    const row = tab.rows[headerRow - 1] ?? [];
    return row.flatMap((cell, index) => {
      const header = textOf(cell).trim();
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

  private column(
    tab: MemoryTab,
    headerRow: number,
    header: string,
  ): ColumnInfo {
    const column = this.headers(tab, headerRow).find(
      (h) => h.normalised === normaliseKey(header),
    );
    if (!column)
      throw new SheetError(`No column "${header}"`, "header_not_found");
    return column;
  }

  private rowAt(tab: MemoryTab, rowNumber: number): MemoryCell[] {
    while (tab.rows.length < rowNumber) tab.rows.push([]);
    return tab.rows[rowNumber - 1]!;
  }

  private assertWritable() {
    if (this.options.readOnly)
      throw new SheetError("These sheets are read-only", "read_only");
  }

  private async changed(fileId: string) {
    const now = this.options.now?.() ?? new Date();
    // Distinct, increasing timestamps even when several changes land in the same millisecond.
    this.tick += 1;
    this.file(fileId).modifiedTime = new Date(
      now.getTime() + this.tick,
    ).toISOString();
    await this.options.onChange?.(this.files);
  }

  // ---- Test helpers: edits people make in sheets ---------------------------------------------

  /** Sets one cell by header, as a person typing. Dates may be given as "yyyy-mm-dd" serials. */
  async setCell(
    ref: TabRef,
    headerRow: number,
    row: number,
    header: string,
    value: string | number | null,
  ) {
    const tab = this.tab(ref);
    const column = this.column(tab, headerRow, header);
    const text =
      value === null
        ? ""
        : typeof value === "number"
          ? formatDate(fromSheetsSerial(value), "dd-MMM-yy")
          : value;
    this.rowAt(tab, row)[column.index] = { value, formatted: text };
    await this.changed(ref.fileId);
  }

  /** Inserts an empty row before `row`, shifting the rows below down. */
  async insertRow(ref: TabRef, row: number, cells: MemoryCell[] = []) {
    this.tab(ref).rows.splice(row - 1, 0, cells);
    await this.changed(ref.fileId);
  }

  async deleteRow(ref: TabRef, row: number) {
    this.tab(ref).rows.splice(row - 1, 1);
    await this.changed(ref.fileId);
  }

  /** Sorts the data rows below the header row, as a person sorting the sheet. */
  async sortRows(
    ref: TabRef,
    headerRow: number,
    compare: (a: MemoryCell[], b: MemoryCell[]) => number,
  ) {
    const tab = this.tab(ref);
    const data = tab.rows.splice(headerRow);
    data.sort(compare);
    tab.rows.push(...data);
    await this.changed(ref.fileId);
  }

  /** Moves a column to a new index, as a person dragging it. */
  async moveColumn(ref: TabRef, from: number, to: number) {
    for (const row of this.tab(ref).rows) {
      while (row.length <= Math.max(from, to)) row.push({ ...EMPTY });
      const [cell] = row.splice(from, 1);
      row.splice(to, 0, cell ?? { ...EMPTY });
    }
    await this.changed(ref.fileId);
  }

  /** Test helper: someone deletes a whole column (0-based index). */
  async deleteColumn(ref: TabRef, index: number) {
    for (const row of this.tab(ref).rows) row.splice(index, 1);
    await this.changed(ref.fileId);
  }
}

/** A one-tab spreadsheet from plain values, for tests. Numbers are stored as numbers. */
export function memoryFile(
  name: string,
  grid: (string | number | null)[][],
  options: {
    id?: string;
    sheetId?: number;
    title?: string;
    formulaColumns?: number[];
  } = {},
): MemoryFile {
  return {
    id: options.id ?? `file-${randomUUID()}`,
    name,
    mimeType: GOOGLE_SHEET_MIME,
    modifiedTime: "2026-09-25T00:00:00.000Z",
    tabs: [
      {
        sheetId: options.sheetId ?? 0,
        title: options.title ?? "Sheet1",
        rows: grid.map((row, r) =>
          row.map((value, c) => ({
            value,
            formatted:
              value === null
                ? ""
                : typeof value === "number"
                  ? formatDate(fromSheetsSerial(value), "dd-MMM-yy")
                  : value,
            ...(r > 0 &&
            options.formulaColumns?.includes(c) &&
            row.some((v) => v !== null)
              ? { formula: "=1" }
              : {}),
          })),
        ),
        validations: [],
        hiddenColumns: [],
        protectedColumns: [],
      },
    ],
  };
}
