import type { CellValue } from "@/lib/domain/dates";
import type { SheetRow } from "@/lib/domain/rows";

/**
 * PRD 7.5: all sheet access goes through SheetSource, so the sync engine runs the same way on
 * Google (GoogleSheetSource), the example xlsx files (XlsxFixtureSource) and in-memory sheets
 * for tests and local development (MemorySheetSource).
 *
 * Headers are always matched normalised (trim, lowercase, collapsed whitespace). Rows are
 * 1-based sheet row numbers. Tabs are identified by sheetId (the gid), never by name (7.4).
 */

export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
export const KNIT_ID_HEADER = "Knit ID";
export const KNIT_NOTE_HEADER = "Knit Note";

export type { CellValue, SheetRow };

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
}

export interface TabRef {
  fileId: string;
  sheetId: number;
}

/**
 * A tab that can hold a tracker: a grid sheet (chart and data-source sheets are never listed).
 * rowCount and columnCount are the tab's grid size: every row and column that exists, empty or
 * not (Google's gridProperties; a new Google tab is 1000 x 26). An in-memory tab's grid is
 * exactly the rows and columns it stores.
 */
export interface TabInfo {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface ColumnInfo {
  /** 0-based column index. */
  index: number;
  letter: string;
  header: string;
  normalised: string;
}

export interface ColumnValidation {
  /** The dropdown's options, or null when the rule could not be read (a missing range). */
  options: string[] | null;
  /** Where the options come from: the literal list or the referenced range. */
  source: string;
}

export interface TabStructure {
  headers: ColumnInfo[];
  /**
   * Normalised headers of formula columns (N6): a data cell holds a formula or is filled by an
   * array formula, or the header cell itself is (an array formula anchored in the header).
   */
  formulaColumns: string[];
  /** Dropdown rules on data cells, by normalised header (6.8, 11 step 5). */
  validations: Record<string, ColumnValidation>;
  /** Normalised headers that appear more than once in the header row. */
  duplicateHeaders: string[];
}

/** A value to write. `text` is stored as text; `date` ("yyyy-mm-dd") as a real date cell. */
export interface CellWrite {
  row: number;
  header: string;
  kind: "text" | "date";
  /** An empty string clears the cell. */
  value: string;
}

export interface SheetSource {
  listFolder(): Promise<DriveFile[]>;
  getFileModifiedTime(fileId: string): Promise<string>;
  listTabs(fileId: string): Promise<TabInfo[]>;
  /** The first rows as displayed, for choosing the header row in the wizard (11 step 3). */
  readTopRows(ref: TabRef, count: number): Promise<string[][]>;
  readStructure(ref: TabRef, headerRow: number): Promise<TabStructure>;
  readRows(ref: TabRef, headerRow: number): Promise<SheetRow[]>;
  readColumn(
    ref: TabRef,
    headerRow: number,
    header: string,
  ): Promise<{ row: number; value: string }[]>;
  /**
   * Adds the Knit ID and Knit Note columns if missing (11 step 9), at the first columns after
   * the last used header that are empty in every row from the header row down, so no cell of
   * the tracker is ever overwritten (invariants 5, 6).
   */
  ensureKnitColumns(
    ref: TabRef,
    headerRow: number,
  ): Promise<{ knitIdHeader: string; knitNoteHeader: string }>;
  writeCells(ref: TabRef, headerRow: number, cells: CellWrite[]): Promise<void>;
}

export class SheetError extends Error {
  override name = "SheetError";
  constructor(
    message: string,
    readonly code:
      | "file_not_found"
      | "tab_not_found"
      | "header_not_found"
      | "read_only"
      | "api_error",
    /** The HTTP status of a Google answer, when there was one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** 0 is A, 25 is Z, 26 is AA. */
export function columnLetter(index: number): string {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

export function columnIndex(letter: string): number {
  return (
    [...letter.toUpperCase()].reduce(
      (n, ch) => n * 26 + ch.charCodeAt(0) - 64,
      0,
    ) - 1
  );
}
