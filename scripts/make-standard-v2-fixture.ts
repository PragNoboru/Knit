// Dev only: builds fixtures/trackers/Knit_Standard_Tracker_v2_example.xlsx, the example in the
// Knit Standard Tracker v2 layout (PRD 11.1, N72 to N74), from the v1 example made by
// make-standard-fixture.ts. v2 is v1 with a Maker column right after Owner, so this script
// inserts column H ("Maker") into the Tasks sheet and moves everything from H on one column
// right: the cells, column widths, conditional formats, dropdown rules (their Lists ranges stay
// Google's), the header notes, and the Summary formulas that read Tasks. It then types ten
// example rows (NOB-01 to NOB-10) with Owner and Maker the same, different, blank Maker, and
// comma lists, plus the brand column Budget, now P. The Guide tab is brought to v2: the version,
// 15 columns, Owner as who checks the task, and a Maker row in both of its column tables.
//
//   pnpm exec tsx scripts/make-standard-v2-fixture.ts
//
// It is run once by hand and is never part of the app or a test.
import { readFileSync, writeFileSync } from "node:fs";

import { columnIndex, columnLetter } from "@/lib/sheets/types";
import { toSheetsSerial } from "@/lib/time";

import { readZip, writeZip, type ZipEntry } from "./xlsx-zip";

const IN = "fixtures/trackers/Knit_Standard_Tracker_v1_example.xlsx";
const OUT = "fixtures/trackers/Knit_Standard_Tracker_v2_example.xlsx";
const TASKS_XML = "xl/worksheets/sheet1.xml";
const SUMMARY_XML = "xl/worksheets/sheet2.xml";
const COMMENTS_XML = "xl/comments1.xml";
const NOTES_VML = "xl/drawings/vmlDrawing1.vml";
const GUIDE_XML = "xl/worksheets/sheet4.xml";

/** Column H (0-based 7): Maker goes here, and v1's H onwards moves one right. */
const MAKER = 7;
const shift = (letters: string) => {
  const index = columnIndex(letters);
  return index >= MAKER ? columnLetter(index + 1) : letters;
};

type Value = string | { date: string } | null;

// Columns A to P: Task ID, Date, End date, Task, Details / done when, Workstream, Owner, Maker,
// Priority, Status, Stage, Done on, Depends on, Link, Notes, Budget (a brand column).
const ROWS: Value[][] = [
  // Owner and Maker the same person.
  [
    "NOB-01",
    { date: "2026-09-28" },
    null,
    "Retire the old landing page",
    "No old offer anywhere on the site",
    "Website",
    "Pragaman",
    "Pragaman",
    "Normal",
    "Done",
    null,
    { date: "2026-09-28" },
    null,
    null,
    null,
    null,
  ],
  // A blank Maker: the Owner does it.
  [
    "NOB-02",
    { date: "2026-09-29" },
    null,
    "Test the lead form",
    null,
    "Tracking",
    "Pragaman",
    null,
    "Normal",
    "In progress",
    null,
    null,
    null,
    null,
    null,
    null,
  ],
  // Different Owner and Maker: it reaches the Maker, and shows its Owner.
  [
    "NOB-03",
    { date: "2026-10-01" },
    null,
    "Sign off the launch budget",
    "Budget approved in writing",
    "Admin",
    "Shlok",
    "Pragaman",
    "High",
    "Not started",
    null,
    null,
    null,
    null,
    null,
    "50000",
  ],
  // A comma list of Makers.
  [
    "NOB-04",
    { date: "2026-10-05" },
    { date: "2026-10-09" },
    "Set up the search campaigns",
    "Three campaigns ready to launch",
    "Ads",
    "Pragaman",
    "Pragaman, Shlok",
    "Normal",
    "In progress",
    "Brief ready",
    null,
    "NOB-03",
    null,
    null,
    "30000",
  ],
  [
    "NOB-05",
    { date: "2026-10-12" },
    { date: "2026-10-12" },
    "Draft the ad copy",
    null,
    "Copy",
    "Pragaman",
    null,
    "Normal",
    null,
    "Copy ready",
    null,
    null,
    null,
    null,
    null,
  ],
  [
    "NOB-06",
    { date: "2026-10-13" },
    { date: "2026-10-18" },
    "Watch the launch week",
    "Daily check of spend and leads",
    "Launch",
    "Shlok",
    "Pragaman, Aryan",
    "High",
    "Not started",
    null,
    null,
    "NOB-04",
    null,
    null,
    null,
  ],
  [
    "NOB-07",
    { date: "2026-10-19" },
    { date: "2026-10-20" },
    "Review the first leads",
    null,
    "Leads",
    "Pragaman",
    "Pragaman",
    "Normal",
    "Blocked",
    null,
    null,
    "NOB-06",
    null,
    "Waiting on the CRM export",
    null,
  ],
  // Pragaman is only its Owner: Creative makes it, so it is not on his Today.
  [
    "NOB-08",
    { date: "2026-10-14" },
    null,
    "Make the retargeting banners",
    "Four sizes",
    null,
    "Pragaman",
    "Creative",
    "Normal",
    "Not started",
    "In review",
    null,
    null,
    "https://example.com/banners",
    null,
    null,
  ],
  [
    "NOB-09",
    { date: "2026-10-21" },
    null,
    "Shoot the explainer video",
    null,
    "Video",
    "Pragaman",
    null,
    "Low",
    "Cancelled",
    null,
    null,
    null,
    null,
    "Dropped for this launch",
    null,
  ],
  // An Owner Knit does not know: never looked up, since the Maker is filled (N73).
  [
    "NOB-10",
    { date: "2026-11-02" },
    { date: "2026-11-30" },
    "Report on November's leads",
    "Weekly numbers in the report",
    "Reporting",
    "Riya",
    "P",
    "Normal",
    "In progress",
    null,
    null,
    null,
    null,
    null,
    null,
  ],
];

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A1 references in a same-sheet range or formula: $I2, B2:C1000, A2:N1000. */
const shiftRefs = (text: string) =>
  text.replace(
    /(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z])/g,
    (_m, d1: string, col: string, d2: string, row: string) =>
      `${d1}${shift(col)}${d2}${row}`,
  );

function entry(entries: ZipEntry[], name: string): ZipEntry {
  const found = entries.find((e) => e.name === name);
  if (!found) throw new Error(`The v1 example has no ${name}`);
  return found;
}

function tasksSheet(xml: string): string {
  // Column widths: Maker as wide as Owner, the rest one column right.
  xml = xml.replace(/<col ([^>]*)\/>/g, (whole, attributes: string) => {
    const min = Number(/min="(\d+)"/.exec(attributes)![1]);
    const max = Number(/max="(\d+)"/.exec(attributes)![1]);
    const moved = (n: number) => (n >= MAKER + 1 ? n + 1 : n);
    const col = `<col ${attributes
      .replace(/min="\d+"/, `min="${moved(min)}"`)
      .replace(/max="\d+"/, `max="${moved(max)}"`)}/>`;
    return min === MAKER
      ? `${col}<col customWidth="1" min="${MAKER + 1}" max="${MAKER + 1}" width="16.0"/>`
      : col;
  });

  // Cells: H onwards one column right, and a new H cell after G, styled as G.
  xml = xml.replace(
    /<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g,
    (_whole, row: string, attributes: string, body: string) => {
      const cells = [
        ...body.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>[\s\S]*?<\/c>)/g),
      ];
      const out = cells.map(([, col, , rest, tail]) => {
        let cell = `<c r="${shift(col!)}${row}"${rest}${tail}`;
        if (col === "G") {
          const style = /s="(\d+)"/.exec(rest!)?.[1] ?? "19";
          cell +=
            row === "1"
              ? `<c r="H1" s="9" t="inlineStr"><is><t>Maker</t></is></c>`
              : `<c r="H${row}" s="${style}"/>`;
        }
        return cell;
      });
      if (out.length !== cells.length || cells.length === 0)
        throw new Error(`Row ${row} could not be read`);
      return `<row r="${row}"${attributes}>${out.join("")}</row>`;
    },
  );

  // Conditional formats and dropdown rules: ranges and same-sheet references move; the
  // dropdowns' Lists ranges (formula1) do not.
  xml = xml.replace(
    /<conditionalFormatting sqref="([^"]+)">([\s\S]*?)<\/conditionalFormatting>/g,
    (_whole, sqref: string, body: string) =>
      `<conditionalFormatting sqref="${shiftRefs(sqref)}">${body.replace(
        /<formula>([\s\S]*?)<\/formula>/g,
        (_f, formula: string) => `<formula>${shiftRefs(formula)}</formula>`,
      )}</conditionalFormatting>`,
  );
  xml = xml.replace(
    /(<dataValidation\b[^>]*?sqref=")([^"]+)(")/g,
    (_whole, before: string, sqref: string, after: string) =>
      `${before}${shiftRefs(sqref)}${after}`,
  );
  // Maker picks from the same people list as Owner (Lists!C).
  xml = xml.replace(
    "</dataValidations>",
    `<dataValidation type="list" allowBlank="1" showInputMessage="1" prompt="Maker not in the list - Add this person to the Owner list on the Lists tab. Several makers: separate with a comma. Leave blank when the Owner does it." sqref="H2:H1000"><formula1>Lists!$C$2:$C$25</formula1></dataValidation></dataValidations>`,
  );

  // The example rows: every data cell of rows 2 to 11 emptied (its style kept), then typed.
  ROWS.forEach((values, index) => {
    const row = index + 2;
    values.forEach((value, column) => {
      const ref = `${columnLetter(column)}${row}`;
      const cell = new RegExp(
        `<c r="${ref}" s="(\\d+)"(?:/>|[^>]*>[\\s\\S]*?</c>)`,
      );
      const match = cell.exec(xml);
      if (!match) throw new Error(`No cell ${ref}`);
      const style = match[1]!;
      const typed =
        value === null
          ? `<c r="${ref}" s="${style}"/>`
          : typeof value === "object"
            ? `<c r="${ref}" s="22"><v>${toSheetsSerial(value.date)}</v></c>`
            : `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
      xml = xml.replace(cell, typed);
    });
  });
  return xml;
}

/** Summary formulas read Tasks!$I$2:$I$1000 and the like: those columns move too. */
function summarySheet(xml: string): string {
  return xml.replace(
    /Tasks!(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?/g,
    (
      _whole,
      d1: string,
      c1: string,
      d2: string,
      r1: string,
      d3?: string,
      c2?: string,
      d4?: string,
      r2?: string,
    ) =>
      `Tasks!${d1}${shift(c1)}${d2}${r1}` +
      (c2 ? `:${d3 ?? ""}${shift(c2)}${d4 ?? ""}${r2}` : ""),
  );
}

const OWNER_NOTE =
  "REQUIRED. Who is responsible for checking that it is done, from the Lists tab. Several people: separate with a comma ('Pragaman, Shlok').";
const MAKER_NOTE =
  "Optional. Who does it, from the Lists tab. Several people: separate with a comma. Leave blank when the Owner does it. Knit puts the task on the Maker's Today.";

/** The header notes: H onwards one column right, Owner's note reworded, a note for Maker. */
function comments(xml: string): string {
  xml = xml.replace(
    /ref="([A-Z]+)1"/g,
    (_w, col: string) => `ref="${shift(col)}1"`,
  );
  xml = xml.replace(
    /(<comment authorId="0" ref="G1"><text><t xml:space="preserve">)[^<]*(<\/t>)/,
    `$1${OWNER_NOTE}$2`,
  );
  return xml.replace(
    /(<comment authorId="0" ref="G1">[\s\S]*?<\/comment>)/,
    `$1<comment authorId="0" ref="H1"><text><t xml:space="preserve">${MAKER_NOTE}</t></text></comment>`,
  );
}

/** The notes' boxes: anchored one column right from H on, and one more box for Maker. */
function noteShapes(vml: string): string {
  const shapes = [...vml.matchAll(/<v:shape [\s\S]*?<\/v:shape>/g)].map(
    (m) => m[0],
  );
  const moved = shapes.map((shape) => {
    const column = Number(/<x:Column>(\d+)<\/x:Column>/.exec(shape)![1]);
    if (column < MAKER) return shape;
    return shape
      .replace(
        /<x:Column>\d+<\/x:Column>/,
        `<x:Column>${column + 1}</x:Column>`,
      )
      .replace(/<x:Anchor>([^<]*)<\/x:Anchor>/, (_w, anchor: string) => {
        const parts = anchor.split(",").map((p) => Number(p.trim()));
        parts[0]! += 1;
        parts[4]! += 1;
        return `<x:Anchor>${parts.join(", ")}</x:Anchor>`;
      });
  });
  const owner = shapes.find((s) => /<x:Column>6<\/x:Column>/.test(s))!;
  const ids = shapes.map((s) => Number(/id="_x0000_s(\d+)"/.exec(s)![1]));
  const maker = owner
    .replace(/id="_x0000_s\d+"/, `id="_x0000_s${Math.max(...ids) + 1}"`)
    .replace(/<x:Column>6<\/x:Column>/, `<x:Column>${MAKER}</x:Column>`)
    .replace(
      /<x:Anchor>[^<]*<\/x:Anchor>/,
      `<x:Anchor>${MAKER + 1}, 15, 1, 10, ${MAKER + 5}, 15, 3, 4</x:Anchor>`,
    );
  let out = vml;
  shapes.forEach((shape, i) => {
    out = out.replace(
      shape,
      i === shapes.indexOf(owner) ? `${moved[i]}${maker}` : moved[i]!,
    );
  });
  return out;
}

/** The Guide tab's cells that name v1, its 14 columns, or Owner as who does the task. */
const GUIDE_TEXT: Record<string, string> = {
  B1: "Knit Standard Tracker v2",
  B2: "One tracker format for every brand: Filing Buddy, Noboru, Sapiens, Auxman and whatever comes next. Version 2, 2 Oct 2026: Maker added after Owner.",
  B13: "1. Row 1 is the header row. Never add title rows above it, and never rename, reorder or delete the 15 standard columns.",
  B14: "2. One task per row: one action, one date, one Owner who checks it, and a Maker when someone else does it (comma lists are fine).",
  B24: "The 15 standard columns",
  D32: "Who checks that it is done, from the Lists tab. Comma for several.",
  B73: "2. Lists tab: fill Owner (the people list for Owner and Maker) and Workstream for the brand. Fill Stage only if it has a pipeline; otherwise clear it.",
  B74: "3. Several people per task? In Google Sheets open Data > Data validation, pick the Owner and Maker rules and turn on 'Allow multiple selections'.",
};
/** Rows added after the Owner rows of the Guide's two tables (v1 rows 32 and 50). */
const GUIDE_MAKER_ROWS: { after: number; text: Record<string, string> }[] = [
  {
    after: 32,
    text: {
      B: "Maker",
      C: "Optional",
      D: "Who does it, from the Lists tab. Blank when the Owner does it. Knit puts the task on the Maker's Today. Comma for several.",
      E: "Shlok",
    },
  },
  { after: 50, text: { B: "Maker", C: "(blank: the Owner does it)" } },
];

/** A cell's text, typed in place as an inline string; its style is kept. */
function setCellText(xml: string, ref: string, text: string): string {
  const cell = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const match = cell.exec(xml);
  if (!match) throw new Error(`No Guide cell ${ref}`);
  const style = /s="(\d+)"/.exec(match[1]!)?.[1];
  return xml.replace(
    cell,
    `<c r="${ref}"${style ? ` s="${style}"` : ""} t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`,
  );
}

/** Inserts a copy of row `after` below it, every later row (and merge) one row down. */
function insertRowAfter(
  xml: string,
  after: number,
  text: Record<string, string>,
): string {
  const down = (n: number) => (n > after ? n + 1 : n);
  xml = xml.replace(
    /<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g,
    (_whole, row: string, attributes: string, body: string) => {
      const n = down(Number(row));
      const moved = body.replace(
        /<c r="([A-Z]+)\d+"/g,
        (_c, col: string) => `<c r="${col}${n}"`,
      );
      let out = `<row r="${n}"${attributes}>${moved}</row>`;
      if (Number(row) === after) {
        let copy = `<row r="${after + 1}"${attributes}>${body.replace(
          /<c r="([A-Z]+)\d+"/g,
          (_c, col: string) => `<c r="${col}${after + 1}"`,
        )}</row>`;
        // The copy's other cells are empty in both tables (or merged into C).
        for (const [col, value] of Object.entries(text))
          copy = setCellText(copy, `${col}${after + 1}`, value);
        out += copy;
      }
      return out;
    },
  );
  const merges: string[] = [];
  xml = xml.replace(
    /<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g,
    (_m, c1: string, r1: string, c2: string, r2: string) => {
      if (Number(r1) === after)
        merges.push(`<mergeCell ref="${c1}${after + 1}:${c2}${after + 1}"/>`);
      return `<mergeCell ref="${c1}${down(Number(r1))}:${c2}${down(Number(r2))}"/>`;
    },
  );
  return xml
    .replace("</mergeCells>", `${merges.join("")}</mergeCells>`)
    .replace(
      /<mergeCells count="\d+">/,
      () =>
        `<mergeCells count="${(xml.match(/<mergeCell ref=/g)?.length ?? 0) + merges.length}">`,
    );
}

/** The Guide tab: names v2 and its 15 columns, Owner as who checks, and adds Maker rows. */
function guideSheet(xml: string): string {
  for (const [ref, text] of Object.entries(GUIDE_TEXT))
    xml = setCellText(xml, ref, text);
  // From the bottom up, so the second table's row number is still v1's.
  for (const { after, text } of [...GUIDE_MAKER_ROWS].reverse())
    xml = insertRowAfter(xml, after, text);
  return xml;
}

function main() {
  const entries = readZip(readFileSync(IN));
  const edit = (name: string, change: (text: string) => string) => {
    const e = entry(entries, name);
    e.data = Buffer.from(change(e.data.toString("utf8")), "utf8");
  };
  edit(TASKS_XML, tasksSheet);
  edit(SUMMARY_XML, summarySheet);
  edit(COMMENTS_XML, comments);
  edit(NOTES_VML, noteShapes);
  edit(GUIDE_XML, guideSheet);
  const out = writeZip(entries);
  writeFileSync(OUT, out);
  console.log(`Wrote ${OUT} (${out.length} bytes)`);
}

main();
