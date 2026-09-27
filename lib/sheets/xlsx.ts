import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import * as XLSX from "xlsx";

import {
  MemorySheetSource,
  type MemoryCell,
  type MemoryFile,
  type MemoryValidation,
} from "./memory";
import { columnIndex, GOOGLE_SHEET_MIME } from "./types";

/**
 * Loads .xlsx workbooks into the in-memory model (PRD 7.5): XlsxFixtureSource reads the example
 * trackers in fixtures/trackers read-only (fixture tests, 17), and local development starts from
 * them. Dates stay Sheets-style serial numbers, formulas are kept so formula columns are
 * detected (N6), and dropdown rules are read from the sheet XML (SheetJS does not expose them).
 */

const ZIP_ENTRY_PREFIX = "/xl/worksheets/";

function sheetXml(buffer: Buffer, sheetIndex: number): string | null {
  const container = XLSX.CFB.read(buffer, { type: "buffer" });
  const entry = XLSX.CFB.find(
    container,
    `${ZIP_ENTRY_PREFIX}sheet${sheetIndex + 1}.xml`,
  );
  if (!entry?.content) return null;
  return Buffer.from(entry.content as Uint8Array).toString("utf8");
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Parses an A1 range such as "I2:I35" or "$A$2:$A$5". */
function parseRange(
  ref: string,
): { c1: number; r1: number; c2: number; r2: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  return {
    c1: columnIndex(m[1]!),
    r1: Number(m[2]),
    c2: columnIndex(m[3] ?? m[1]!),
    r2: Number(m[4] ?? m[2]),
  };
}

function validationsOf(
  xml: string,
  workbook: XLSX.WorkBook,
): MemoryValidation[] {
  const rules: MemoryValidation[] = [];
  const pattern =
    /<(?:x14:)?dataValidation\b([^>]*)>([\s\S]*?)<\/(?:x14:)?dataValidation>/g;
  for (const [, attributes, body] of xml.matchAll(pattern)) {
    if (!/type="list"/.test(attributes!)) continue;
    const formula = decodeXml(
      /<(?:x14:)?formula1>(?:<xm:f>)?([\s\S]*?)(?:<\/xm:f>)?<\/(?:x14:)?formula1>/.exec(
        body!,
      )?.[1] ?? "",
    );
    const sqref =
      /sqref="([^"]+)"/.exec(attributes!)?.[1] ??
      /<xm:sqref>([^<]+)<\/xm:sqref>/.exec(body!)?.[1];
    if (!sqref) continue;

    let options: string[] | null = null;
    if (formula.startsWith('"')) {
      options = formula
        .slice(1, -1)
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o !== "");
    } else {
      // A range such as Lists!$A$2:$A$5: read it if the workbook has that tab.
      const [sheetName, range] = formula.replace(/^=/, "").split("!");
      const target = range
        ? workbook.Sheets[sheetName!.replace(/^'|'$/g, "")]
        : undefined;
      const r = range ? parseRange(range) : null;
      if (target && r) {
        options = [];
        for (let row = r.r1; row <= r.r2; row += 1) {
          const cell = target[
            XLSX.utils.encode_cell({ r: row - 1, c: r.c1 })
          ] as XLSX.CellObject | undefined;
          const text = cell?.w ?? (cell?.v === undefined ? "" : String(cell.v));
          if (text.trim() !== "") options.push(text.trim());
        }
      }
    }
    for (const part of sqref.split(/\s+/)) {
      const r = parseRange(part);
      if (!r) continue;
      for (let column = r.c1; column <= r.c2; column += 1) {
        rules.push({
          column,
          fromRow: r.r1,
          toRow: r.r2,
          options,
          source: formula,
        });
      }
    }
  }
  return rules;
}

function cellOf(cell: XLSX.CellObject | undefined): MemoryCell {
  if (!cell || cell.t === "z") return { value: null, formatted: "" };
  const value =
    cell.t === "n"
      ? Number(cell.v)
      : cell.t === "b"
        ? Boolean(cell.v)
        : cell.t === "e"
          ? null
          : String(cell.v ?? "");
  const formatted = cell.w ?? (value === null ? "" : String(value));
  // N6: every cell of an array formula's range carries F (the range); only its first cell
  // holds the formula (f). The others are filled by it, as Google's array formula outputs.
  if (cell.f) return { value, formatted, formula: `=${cell.f}` };
  if (cell.F) return { value, formatted, formula: `{array ${cell.F}}` };
  return { value, formatted };
}

/** One workbook as a MemoryFile. The file name (without extension) is its id. */
export function loadXlsxFile(filePath: string): MemoryFile {
  const buffer = readFileSync(filePath);
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellFormula: true,
    cellNF: true,
    cellDates: false,
  });
  const tabs = workbook.SheetNames.map((title, index) => {
    const sheet = workbook.Sheets[title]!;
    const rows: MemoryCell[][] = [];
    if (sheet["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      for (let r = 0; r <= range.e.r; r += 1) {
        const row: MemoryCell[] = [];
        for (let c = 0; c <= range.e.c; c += 1) {
          row.push(
            cellOf(
              sheet[XLSX.utils.encode_cell({ r, c })] as
                XLSX.CellObject | undefined,
            ),
          );
        }
        // Trim trailing empty cells, and skip storing fully empty trailing rows below.
        while (
          row.length > 0 &&
          row[row.length - 1]!.value === null &&
          !row[row.length - 1]!.formula
        )
          row.pop();
        rows.push(row);
      }
      while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
    }
    const xml = sheetXml(buffer, index);
    return {
      sheetId: index,
      title,
      rows,
      validations: xml ? validationsOf(xml, workbook) : [],
      hiddenColumns: [],
      protectedColumns: [],
    };
  });
  const name = path.basename(filePath).replace(/\.xlsx$/i, "");
  return {
    id: name,
    name,
    // Presented as native Google Sheets: these stand in for the Knit folder's trackers.
    mimeType: GOOGLE_SHEET_MIME,
    modifiedTime: statSync(filePath).mtime.toISOString(),
    tabs,
  };
}

/** Every .xlsx file in a folder. */
export function loadXlsxFolder(folder: string): MemoryFile[] {
  return readdirSync(folder)
    .filter((name) => name.toLowerCase().endsWith(".xlsx"))
    .sort()
    .map((name) => loadXlsxFile(path.join(folder, name)));
}

/** The example trackers, read-only (PRD 7.5, 17). */
export class XlsxFixtureSource extends MemorySheetSource {
  constructor(folder: string) {
    super(loadXlsxFolder(folder), { readOnly: true });
  }
}
