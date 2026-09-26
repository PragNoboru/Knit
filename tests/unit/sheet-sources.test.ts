import { describe, expect, it } from "vitest";

import { GoogleSheetSource } from "@/lib/sheets/google";
import { memoryFile, MemorySheetSource } from "@/lib/sheets/memory";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  SheetError,
} from "@/lib/sheets/types";
import { XlsxFixtureSource } from "@/lib/sheets/xlsx";

const HEADER = 3; // a tracker whose header is on row 3, under a title and a blank row

function awkwardTracker() {
  // Robustness: title rows above the header, odd header spacing and case, a blank row in the
  // middle, a duplicated header, a formula column and dates as both text and serials.
  const file = memoryFile(
    "Awkward",
    [
      ["Campaign plan Q4", null, null, null, null],
      [null, null, null, null, null],
      ["  Date ", "TASK", "Status", "Notes", "notes"],
      ["Mon 28 Sep", "Brief the agency", "Not started", "a", "b"],
      [null, null, null, null, null],
      [46296, "Review creatives", "In progress", null, null],
    ],
    { formulaColumns: [3] },
  );
  return {
    source: new MemorySheetSource([file]),
    ref: { fileId: file.id, sheetId: 0 },
  };
}

describe("MemorySheetSource (PRD 7.5)", () => {
  it("finds headers normalised, skips blank rows, keeps row numbers", async () => {
    const { source, ref } = awkwardTracker();
    const rows = await source.readRows(ref, HEADER);
    expect(rows.map((r) => r.rowNumber)).toEqual([4, 6]);
    expect(rows[0]!.cells.date).toEqual({
      value: "Mon 28 Sep",
      formatted: "Mon 28 Sep",
    });
    expect(rows[1]!.cells.date!.value).toBe(46296);
    expect(rows[0]!.cells.task!.formatted).toBe("Brief the agency");
  });

  it("reports duplicated headers and formula columns", async () => {
    const { source, ref } = awkwardTracker();
    const structure = await source.readStructure(ref, HEADER);
    expect(structure.duplicateHeaders).toEqual(["notes"]);
    expect(structure.formulaColumns).toEqual(["notes"]);
  });

  it("adds the Knit columns after the last header, hides and protects Knit ID, once", async () => {
    const { source, ref } = awkwardTracker();
    await source.ensureKnitColumns(ref, HEADER);
    await source.ensureKnitColumns(ref, HEADER);
    const headers = (await source.readStructure(ref, HEADER)).headers.map(
      (h) => h.header,
    );
    expect(headers.slice(-2)).toEqual([KNIT_ID_HEADER, KNIT_NOTE_HEADER]);
    expect(source.tab(ref).hiddenColumns).toEqual([5]);
    expect(source.tab(ref).protectedColumns).toEqual([5]);
  });

  it("writes by header, even after a column has been moved", async () => {
    const { source, ref } = awkwardTracker();
    await source.ensureKnitColumns(ref, HEADER);
    await source.moveColumn(ref, 2, 0); // Status dragged to column A
    await source.writeCells(ref, HEADER, [
      { row: 4, header: "status", kind: "text", value: "Done" },
      { row: 4, header: "Knit ID", kind: "text", value: "id-1" },
    ]);
    const rows = await source.readRows(ref, HEADER);
    expect(rows[0]!.cells.status!.value).toBe("Done");
    expect(await source.readColumn(ref, HEADER, "knit id")).toEqual([
      { row: 4, value: "id-1" },
      { row: 5, value: "" },
      { row: 6, value: "" },
    ]);
  });

  it("stores date writes as real dates, and an empty write clears the cell", async () => {
    const { source, ref } = awkwardTracker();
    await source.writeCells(ref, HEADER, [
      { row: 4, header: "Date", kind: "date", value: "2026-10-05" },
      { row: 6, header: "Notes", kind: "text", value: "" },
    ]);
    const rows = await source.readRows(ref, HEADER);
    expect(typeof rows[0]!.cells.date!.value).toBe("number");
    expect(rows[1]!.cells.notes).toEqual({ value: null, formatted: "" });
  });

  it("bumps the file's modified time on every change", async () => {
    const { source, ref } = awkwardTracker();
    const before = await source.getFileModifiedTime(ref.fileId);
    await source.writeCells(ref, HEADER, [
      { row: 4, header: "Status", kind: "text", value: "Done" },
    ]);
    expect(await source.getFileModifiedTime(ref.fileId)).not.toBe(before);
  });

  it("keeps the example trackers read-only", async () => {
    const fixtures = new XlsxFixtureSource("fixtures/trackers");
    const [file] = await fixtures.listFolder();
    await expect(
      fixtures.writeCells({ fileId: file!.id, sheetId: 0 }, 1, [
        { row: 2, header: "Status", kind: "text", value: "Done" },
      ]),
    ).rejects.toBeInstanceOf(SheetError);
  });
});

/** A fake Google API: routes by path and query, records every request. */
function fakeGoogle(
  routes: [RegExp, (url: URL, body: unknown) => unknown | Response][],
) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url, body });
    const route = routes.find(([pattern]) =>
      pattern.test(decodeURIComponent(url.pathname + url.search)),
    );
    if (!route)
      return new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), {
        status: 404,
      });
    const result = route[1](url, body);
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const source = new GoogleSheetSource({
    folderId: "folder-1",
    getToken: async () => "token",
    fetch: fetchImpl,
    sleep: async () => {},
  });
  return { source, calls };
}

const TABS = {
  sheets: [
    {
      properties: {
        sheetId: 7,
        title: "Copy of Google",
        gridProperties: { rowCount: 40, columnCount: 12 },
      },
    },
  ],
};
const ref = { fileId: "sheet-1", sheetId: 7 };

describe("GoogleSheetSource (PRD 7.4)", () => {
  it("lists the Knit folder across pages", async () => {
    let page = 0;
    const { source, calls } = fakeGoogle([
      [
        /drive\/v3\/files\?/,
        () =>
          page++ === 0
            ? {
                files: [
                  {
                    id: "a",
                    name: "A",
                    mimeType: "application/vnd.google-apps.spreadsheet",
                    modifiedTime: "t1",
                  },
                ],
                nextPageToken: "p2",
              }
            : {
                files: [
                  {
                    id: "b",
                    name: "B.xlsx",
                    mimeType:
                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    modifiedTime: "t2",
                  },
                ],
              },
      ],
    ]);
    expect((await source.listFolder()).map((f) => f.id)).toEqual(["a", "b"]);
    expect(calls[0]!.url.searchParams.get("q")).toBe(
      "'folder-1' in parents and trashed = false",
    );
    expect(calls[1]!.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("reads rows twice: serial dates from unformatted values, text as displayed", async () => {
    const { source } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /valueRenderOption=UNFORMATTED_VALUE/,
        () => ({
          valueRanges: [
            {
              values: [
                ["Date", "Task", "Status"],
                [46293, "Publish", "Not started"],
                [],
                ["Mon 5 Oct", "Watch", ""],
              ],
            },
          ],
        }),
      ],
      [
        /valueRenderOption=FORMATTED_VALUE/,
        () => ({
          valueRanges: [
            {
              values: [
                ["Date", "Task", "Status"],
                ["28-Sep-26", "Publish", "Not started"],
                [],
                ["Mon 5 Oct", "Watch", ""],
              ],
            },
          ],
        }),
      ],
    ]);
    const rows = await source.readRows(ref, 1);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(rows[0]!.cells.date).toEqual({
      value: 46293,
      formatted: "28-Sep-26",
    });
    expect(rows[1]!.cells.status).toEqual({ value: null, formatted: "" });
  });

  it("detects formula columns and dropdowns, reading range-fed options and marking unreadable ones", async () => {
    const list = (values: string[]) => ({
      condition: {
        type: "ONE_OF_LIST",
        values: values.map((v) => ({ userEnteredValue: v })),
      },
    });
    const range = (r: string) => ({
      condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: r }] },
    });
    const { source } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /includeGridData=true/,
        () => ({
          sheets: [
            {
              data: [
                {
                  rowData: [
                    {
                      values: [
                        { formattedValue: "Date" },
                        { formattedValue: "Day" },
                        { formattedValue: "Done" },
                        { formattedValue: "Status" },
                        { formattedValue: "Owner" },
                      ],
                    },
                    {
                      values: [
                        {},
                        { userEnteredValue: { formulaValue: "=TEXT(A2)" } },
                        { dataValidation: range("=Lists!A2:A5") },
                        { dataValidation: list(["Not started", "Done"]) },
                        { dataValidation: range("=Missing!A1:A3") },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
      [
        /values\/Lists!A2:A5/,
        () => ({ values: [["Yes"], ["No"], ["Moved"], ["Not needed"]] }),
      ],
    ]);
    const structure = await source.readStructure(ref, 1);
    expect(structure.formulaColumns).toEqual(["day"]);
    expect(structure.validations).toEqual({
      done: {
        options: ["Yes", "No", "Moved", "Not needed"],
        source: "=Lists!A2:A5",
      },
      status: { options: ["Not started", "Done"], source: "Not started,Done" },
      owner: { options: null, source: "=Missing!A1:A3" },
    });
  });

  it("writes text with an apostrophe so Sheets keeps it as text, and dates as dates", async () => {
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /values\/.*!1:1/,
        () => ({ values: [["Status", "Done on", "Knit Note"]] }),
      ],
      [/values:batchUpdate/, () => ({})],
    ]);
    await source.writeCells(ref, 1, [
      { row: 5, header: "status", kind: "text", value: "Done" },
      { row: 5, header: "Done on", kind: "text", value: "Mon 5 Oct" },
      { row: 5, header: "Knit Note", kind: "text", value: "" },
    ]);
    const write = calls.find((c) =>
      c.url.pathname.endsWith("values:batchUpdate"),
    )!;
    expect(write.body).toEqual({
      valueInputOption: "USER_ENTERED",
      data: [
        { range: "'Copy of Google'!A5", values: [["'Done"]] },
        { range: "'Copy of Google'!B5", values: [["'Mon 5 Oct"]] },
        { range: "'Copy of Google'!C5", values: [[""]] },
      ],
    });
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    let attempts = 0;
    const { source } = fakeGoogle([
      [
        /drive\/v3\/files\/sheet-1/,
        () =>
          ++attempts < 3
            ? new Response("{}", { status: attempts === 1 ? 429 : 503 })
            : { modifiedTime: "t9" },
      ],
    ]);
    expect(await source.getFileModifiedTime("sheet-1")).toBe("t9");
    expect(attempts).toBe(3);
  });

  it("adds, hides and protects the Knit columns, appending grid columns when full", async () => {
    const full = {
      sheets: [
        {
          properties: {
            sheetId: 7,
            title: "Tasks",
            gridProperties: { rowCount: 40, columnCount: 3 },
          },
        },
      ],
    };
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => full],
      [/values\/.*!1:1/, () => ({ values: [["Date", "Task", "Status"]] })],
      [/:batchUpdate$/, () => ({})],
      [/values:batchUpdate/, () => ({})],
    ]);
    await source.ensureKnitColumns(ref, 1);
    const structural = calls.find((c) =>
      c.url.pathname.endsWith("sheet-1:batchUpdate"),
    )!.body as { requests: Record<string, unknown>[] };
    expect(structural.requests.map((r) => Object.keys(r)[0])).toEqual([
      "appendDimension",
      "updateDimensionProperties",
      "addProtectedRange",
    ]);
    const headers = calls.find((c) =>
      c.url.pathname.endsWith("values:batchUpdate"),
    )!.body;
    expect(headers).toEqual({
      valueInputOption: "RAW",
      data: [
        { range: "'Tasks'!D1", values: [["Knit ID"]] },
        { range: "'Tasks'!E1", values: [["Knit Note"]] },
      ],
    });
  });
});
