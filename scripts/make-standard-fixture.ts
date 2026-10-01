// Dev only: builds fixtures/trackers/Knit_Standard_Tracker_v1_example.xlsx, the example in the
// Knit Standard Tracker v1 layout (PRD 11.1, N68 to N70), from an .xlsx export of Pragaman's
// blank template (Google Sheets: File > Download > Microsoft Excel).
//
//   pnpm exec tsx scripts/make-standard-fixture.ts <path to the exported template.xlsx>
//
// It keeps the export as Google wrote it (the 14 headers, the Lists tab, the dropdown rules,
// Summary and Guide) and only types ten example rows into the Tasks tab, plus a brand column
// ("Budget") after Notes. It edits the Tasks sheet's XML inside the zip with node:zlib, so no
// workbook library rewrites the file (CLAUDE.md lists SheetJS for reading fixtures only). It is
// run once by hand and is never part of the app or a test.
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

import { toSheetsSerial } from "@/lib/time";

const OUT = "fixtures/trackers/Knit_Standard_Tracker_v1_example.xlsx";
const TASKS_XML = "xl/worksheets/sheet1.xml";
// Styles in the export: 19 = body text, 22 = a date shown as "ddd d mmm yyyy", 9 = an
// optional header.
const TEXT = "19";
const DATE = "22";

type Value = string | { date: string } | null;

// Columns A to O: Task ID, Date, End date, Task, Details / done when, Workstream, Owner,
// Priority, Status, Stage, Done on, Depends on, Link, Notes, Budget (a brand column).
const ROWS: Value[][] = [
  [
    "FBG-01",
    { date: "2026-09-28" },
    null,
    "Remove the old pricing page",
    "No 1,999 anywhere on the site",
    "Website",
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
  [
    "FBG-02",
    { date: "2026-09-29" },
    null,
    "Check the conversion tag on the thank-you page",
    null,
    "Tracking",
    "Pragaman",
    "Normal",
    "In progress",
    null,
    null,
    null,
    null,
    null,
    null,
  ],
  [
    "FBG-03",
    { date: "2026-10-01" },
    null,
    "Approve the launch budget",
    "Budget signed off by Pragaman",
    "Admin",
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
  [
    "FBG-04",
    { date: "2026-10-05" },
    { date: "2026-10-09" },
    "Build the search campaigns",
    "Three campaigns ready to launch",
    "Ads",
    "Pragaman",
    "Normal",
    "In progress",
    "Brief ready",
    null,
    "FBG-03",
    null,
    null,
    "30000",
  ],
  [
    "FBG-05",
    { date: "2026-10-12" },
    { date: "2026-10-12" },
    "Write the ad copy",
    null,
    "Copy",
    "Pragaman",
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
    "FBG-06",
    { date: "2026-10-13" },
    { date: "2026-10-18" },
    "Run the launch week",
    "Daily check of spend and leads",
    "Launch",
    "Pragaman, Riya",
    "High",
    "Not started",
    null,
    null,
    "FBG-04",
    null,
    null,
    null,
  ],
  [
    "FBG-07",
    { date: "2026-10-19" },
    { date: "2026-10-20" },
    "Review the first week's leads",
    null,
    "Leads",
    "Pragaman",
    "Normal",
    "Blocked",
    null,
    null,
    "FBG-06",
    null,
    "Waiting on the CRM export",
    null,
  ],
  [
    "FBG-08",
    { date: "2026-10-14" },
    null,
    "Design the retargeting banners",
    "Four sizes",
    null,
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
    "FBG-09",
    { date: "2026-10-21" },
    null,
    "Record the explainer video",
    null,
    "Video",
    "Pragaman",
    "Low",
    "Cancelled",
    null,
    null,
    null,
    null,
    "Dropped for this launch",
    null,
  ],
  [
    "FBG-10",
    { date: "2026-11-02" },
    { date: "2026-11-30" },
    "Report on November's leads",
    "Weekly numbers in the report",
    "Reporting",
    "Pragaman",
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

const COLUMNS = "ABCDEFGHIJKLMNO".split("");

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cellXml(ref: string, value: Value, style: string): string {
  if (value === null) return `<c r="${ref}" s="${style}"/>`;
  if (typeof value === "object")
    return `<c r="${ref}" s="${DATE}"><v>${toSheetsSerial(value.date)}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

/** Replaces one empty, styled cell of the export (`<c r="A2" s="19"/>`) with a value. */
function setCell(xml: string, ref: string, value: Value): string {
  const empty = new RegExp(`<c r="${ref}" s="(\\d+)"/>`);
  const match = empty.exec(xml);
  if (!match) throw new Error(`Cell ${ref} is not an empty cell in the export`);
  const style = ref.startsWith("O") ? TEXT : match[1]!;
  return xml.replace(empty, cellXml(ref, value, style));
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** The entries of a zip file, in order, from its central directory. */
function readZip(zip: Buffer): ZipEntry[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    entries.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** A zip file of the entries, deflated, with a fixed timestamp so the output is stable. */
function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 1; // 1 Oct 2026
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error("Give the path of the exported template .xlsx");
  const entries = readZip(readFileSync(input));
  const entry = entries.find((e) => e.name === TASKS_XML);
  if (!entry) throw new Error("The export has no Tasks sheet XML");
  let xml = entry.data.toString("utf8");

  xml = xml.replace(
    /<c r="O1" s="\d+"\/>/,
    `<c r="O1" s="9" t="inlineStr"><is><t>Budget</t></is></c>`,
  );
  ROWS.forEach((row, index) => {
    row.forEach((value, column) => {
      xml = setCell(xml, `${COLUMNS[column]}${index + 2}`, value);
    });
  });

  entry.data = Buffer.from(xml, "utf8");
  const out = writeZip(entries);
  writeFileSync(OUT, out);
  console.log(`Wrote ${OUT} (${out.length} bytes)`);
}

main();
