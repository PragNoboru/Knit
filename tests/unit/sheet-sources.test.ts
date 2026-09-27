import { describe, expect, it } from "vitest";

import { GoogleSheetSource } from "@/lib/sheets/google";
import { memoryFile, MemorySheetSource } from "@/lib/sheets/memory";
import {
  KNIT_ID_HEADER,
  KNIT_NOTE_HEADER,
  SheetError,
} from "@/lib/sheets/types";
import { XlsxFixtureSource } from "@/lib/sheets/xlsx";
import { GoogleArchive } from "@/lib/sync/archive";

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

  it("puts the Knit columns after unlabelled data or formulas right of the headers, never over them (11 step 9)", async () => {
    const file = memoryFile("Loose", [
      ["Date", "Task", "Status", null, null],
      ["Mon 28 Sep", "Brief", "Not started", "scratch note", null],
      ["Tue 29 Sep", "Review", "Done", null, null],
    ]);
    // A helper formula whose result is blank still uses its column.
    file.tabs[0]!.rows[2]![4] = {
      value: null,
      formatted: "",
      formula: '=IF(C3="Done","","")',
    };
    const source = new MemorySheetSource([file]);
    const ref = { fileId: file.id, sheetId: 0 };
    await source.ensureKnitColumns(ref, 1);
    const headers = (await source.readStructure(ref, 1)).headers;
    expect(headers.map((h) => [h.letter, h.header])).toEqual([
      ["A", "Date"],
      ["B", "Task"],
      ["C", "Status"],
      ["F", KNIT_ID_HEADER],
      ["G", KNIT_NOTE_HEADER],
    ]);
    expect(source.tab(ref).hiddenColumns).toEqual([5]);
    expect(source.tab(ref).rows[1]![3]).toEqual({
      value: "scratch note",
      formatted: "scratch note",
    });
    expect(source.tab(ref).rows[2]![4]!.formula).toBe('=IF(C3="Done","","")');
  });

  it("adds only the missing Knit Note, after the last used column, and changes nothing when both are there", async () => {
    const { source, ref } = awkwardTracker();
    await source.ensureKnitColumns(ref, HEADER);
    await source.setCell(ref, HEADER, HEADER, KNIT_NOTE_HEADER, null);
    await source.ensureKnitColumns(ref, HEADER);
    const headers = (await source.readStructure(ref, HEADER)).headers;
    expect(headers.slice(-2).map((h) => [h.letter, h.header])).toEqual([
      ["F", KNIT_ID_HEADER],
      ["G", KNIT_NOTE_HEADER],
    ]);
    const modified = await source.getFileModifiedTime(ref.fileId);
    await source.ensureKnitColumns(ref, HEADER);
    expect(await source.getFileModifiedTime(ref.fileId)).toBe(modified);
  });

  it("counts a formula in the header cell as a formula column (an array formula anchored there, N6)", async () => {
    const file = memoryFile("Anchored", [
      ["Date", "Status"],
      ["Mon 28 Sep", null],
    ]);
    file.tabs[0]!.rows[0]![1] = {
      value: "Status",
      formatted: "Status",
      formula: '={"Status";ARRAYFORMULA(IF(A2:A="","","Open"))}',
    };
    const source = new MemorySheetSource([file]);
    const structure = await source.readStructure(
      { fileId: file.id, sheetId: 0 },
      1,
    );
    expect(structure.formulaColumns).toEqual(["status"]);
  });
});

/** A fake Google API: routes by path and query, records every request and every wait. */
function fakeGoogle(
  routes: [RegExp, (url: URL, body: unknown) => unknown | Response][],
  options: { now?: () => number } = {},
) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const sleeps: number[] = [];
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
  const api = {
    getToken: async () => "token",
    fetch: fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  const source = new GoogleSheetSource({
    folderId: "folder-1",
    ...api,
    ...options,
  });
  return { source, calls, sleeps, api };
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

/** A typed cell as the Sheets API returns it: the value entered and the value shown. */
const typed = (text: string) => ({
  userEnteredValue: { stringValue: text },
  effectiveValue: { stringValue: text },
  formattedValue: text,
});
/** Google's answer to a range it cannot parse (a tab that does not exist). */
const badRange = () =>
  new Response(
    JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT" } }),
    { status: 400 },
  );

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
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /includeGridData=true/,
        () => ({
          sheets: [
            {
              properties: { sheetId: 7 },
              data: [
                {
                  rowData: [
                    {
                      values: ["Date", "Day", "Done", "Status", "Owner"].map(
                        typed,
                      ),
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
      // A batch holding a range Google cannot parse fails whole (400), as Google does.
      [/values:batchGet.*Missing/, () => badRange()],
      [
        /values\/Lists!A2:A5/,
        () => ({ values: [["Yes"], ["No"], ["Moved"], ["Not needed"]] }),
      ],
      [/values\/Missing!A1:A3/, () => badRange()],
    ]);
    const structure = await source.readStructure(ref, 1);
    expect(structure.formulaColumns).toEqual(["day"]);
    expect(
      calls.filter((c) => c.url.pathname.endsWith("values:batchGet")),
    ).toHaveLength(1);
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

  const tasksTab = (columnCount: number) => ({
    sheets: [
      {
        properties: {
          sheetId: 7,
          title: "Tasks",
          sheetType: "GRID",
          gridProperties: { rowCount: 40, columnCount },
        },
      },
    ],
  });

  it("adds, hides and protects the Knit columns with their headers in one batch, appending grid columns when full", async () => {
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => tasksTab(3)],
      [/values\/.*!1:1/, () => ({ values: [["Date", "Task", "Status"]] })],
      [
        /values\/.*!A1:ZZZ\?.*valueRenderOption=FORMULA/,
        () => ({
          values: [
            ["Date", "Task", "Status"],
            ["Mon 5 Oct", "Go"],
          ],
        }),
      ],
      [/:batchUpdate$/, () => ({})],
    ]);
    await source.ensureKnitColumns(ref, 1);
    const structural = calls.filter((c) => c.method === "POST");
    expect(structural).toHaveLength(1);
    expect(structural[0]!.url.pathname).toBe(
      "/v4/spreadsheets/sheet-1:batchUpdate",
    );
    expect(structural[0]!.body).toEqual({
      requests: [
        {
          appendDimension: { sheetId: 7, dimension: "COLUMNS", length: 2 },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId: 7,
              dimension: "COLUMNS",
              startIndex: 3,
              endIndex: 4,
            },
            properties: { hiddenByUser: true },
            fields: "hiddenByUser",
          },
        },
        {
          addProtectedRange: {
            protectedRange: {
              range: { sheetId: 7, startColumnIndex: 3, endColumnIndex: 4 },
              description: "Managed by Knit",
              warningOnly: true,
            },
          },
        },
        {
          updateCells: {
            start: { sheetId: 7, rowIndex: 0, columnIndex: 3 },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: "Knit ID" } },
                  { userEnteredValue: { stringValue: "Knit Note" } },
                ],
              },
            ],
            fields: "userEnteredValue",
          },
        },
      ],
    });
  });

  it("puts the Knit columns after an unlabelled column holding data or a blank-looking formula (11 step 9)", async () => {
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => tasksTab(26)],
      [/values\/.*!1:1/, () => ({ values: [["Date", "Task", "Status"]] })],
      [
        /values\/.*!A1:ZZZ\?.*valueRenderOption=FORMULA/,
        () => ({
          values: [
            ["Date", "Task", "Status"],
            ["Mon 5 Oct", "Go", "Done", "scratch"],
            ["Tue 6 Oct", "Watch", "", "", '=IF(C3="","","")'],
          ],
        }),
      ],
      [/:batchUpdate$/, () => ({})],
    ]);
    await source.ensureKnitColumns(ref, 1);
    const requests = (
      calls.find((c) => c.method === "POST")!.body as {
        requests: Record<string, { start?: unknown; range?: unknown }>[];
      }
    ).requests;
    expect(requests.map((r) => Object.keys(r)[0])).toEqual([
      "updateDimensionProperties",
      "addProtectedRange",
      "updateCells",
    ]);
    // D and E hold data: Knit ID goes to F (index 5), Knit Note to G.
    expect(requests[0]!.updateDimensionProperties!.range).toMatchObject({
      startIndex: 5,
      endIndex: 6,
    });
    expect(requests[2]!.updateCells!.start).toEqual({
      sheetId: 7,
      rowIndex: 0,
      columnIndex: 5,
    });
  });

  it("never re-sends the structural batch after a 5xx: Google may have applied it", async () => {
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => tasksTab(26)],
      [/values\/.*!1:1/, () => ({ values: [["Date", "Task", "Status"]] })],
      [/valueRenderOption=FORMULA/, () => ({ values: [["Date", "Task"]] })],
      [/:batchUpdate$/, () => new Response("{}", { status: 503 })],
    ]);
    await expect(source.ensureKnitColumns(ref, 1)).rejects.toMatchObject({
      code: "api_error",
      status: 503,
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("re-sends a values write after a 5xx: the same cells get the same values", async () => {
    let writes = 0;
    const { source } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [/values\/.*!1:1/, () => ({ values: [["Status"]] })],
      [
        /values:batchUpdate/,
        () => (++writes === 1 ? new Response("{}", { status: 503 }) : {}),
      ],
    ]);
    await source.writeCells(ref, 1, [
      { row: 5, header: "Status", kind: "text", value: "Done" },
    ]);
    expect(writes).toBe(2);
  });

  it("backs off on 429 for up to about 30 s, doubling from 2 s (7.4)", async () => {
    let attempts = 0;
    const { source, sleeps } = fakeGoogle([
      [
        /drive\/v3\/files\/sheet-1/,
        () =>
          ++attempts < 5
            ? new Response("{}", { status: 429 })
            : { modifiedTime: "t9" },
      ],
    ]);
    expect(await source.getFileModifiedTime("sheet-1")).toBe("t9");
    expect(sleeps).toHaveLength(4);
    [2_000, 4_000, 8_000, 16_000].forEach((base, i) => {
      expect(sleeps[i]).toBeGreaterThanOrEqual(base);
      expect(sleeps[i]).toBeLessThan(base + 1_000);
    });
  });

  it("follows Google's Retry-After on 429, and stops once the wait would pass its budget", async () => {
    let attempts = 0;
    const { source, sleeps } = fakeGoogle([
      [
        /drive\/v3\/files\/sheet-1/,
        () => {
          attempts += 1;
          return new Response("{}", {
            status: 429,
            headers: { "retry-after": "20" },
          });
        },
      ],
    ]);
    await expect(source.getFileModifiedTime("sheet-1")).rejects.toMatchObject({
      code: "api_error",
      status: 429,
    });
    expect(sleeps).toEqual([20_000]);
    expect(attempts).toBe(2);
  });

  it("marks array formula columns: anchored in the header cell, or filled cells with no entered value (N6)", async () => {
    const { source } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /includeGridData=true/,
        () => ({
          sheets: [
            {
              properties: { sheetId: 7 },
              data: [
                {
                  rowData: [
                    {
                      values: [
                        typed("Date"),
                        {
                          userEnteredValue: {
                            formulaValue:
                              '={"Status";ARRAYFORMULA(IF(A2:A="","","Open"))}',
                          },
                          effectiveValue: { stringValue: "Status" },
                          formattedValue: "Status",
                        },
                        typed("Notes"),
                        typed("Done on"),
                        // Filled by an array formula above the header row.
                        {
                          effectiveValue: { stringValue: "Week" },
                          formattedValue: "Week",
                        },
                      ],
                    },
                    {
                      values: [
                        typed("Mon 5 Oct"),
                        {}, // the array formula's result is blank here
                        typed("call back"),
                        {
                          effectiveValue: { numberValue: 46300 },
                          formattedValue: "5-Oct-26",
                        },
                        {
                          effectiveValue: { numberValue: 41 },
                          formattedValue: "41",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    ]);
    const structure = await source.readStructure(ref, 1);
    expect([...structure.formulaColumns].sort()).toEqual([
      "done on",
      "status",
      "week",
    ]);
  });

  it("reads a dropdown range without a tab name from the tracker's own tab, and leaves a named range alone", async () => {
    const range = (r: string) => ({
      dataValidation: {
        condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: r }] },
      },
    });
    const { source, calls } = fakeGoogle([
      [/fields=sheets\.properties/, () => TABS],
      [
        /includeGridData=true/,
        () => ({
          sheets: [
            {
              properties: { sheetId: 7 },
              data: [
                {
                  rowData: [
                    { values: [typed("Status"), typed("Owner")] },
                    { values: [range("=$Z$2:$Z$8"), range("=OwnerList")] },
                  ],
                },
              ],
            },
          ],
        }),
      ],
      [
        /values:batchGet/,
        () => ({
          valueRanges: [
            { values: [["Open"], ["Done"]] },
            { values: [["Pragaman"]] },
          ],
        }),
      ],
    ]);
    const structure = await source.readStructure(ref, 1);
    const batch = calls.find((c) => c.url.pathname.endsWith("values:batchGet"));
    expect(batch!.url.searchParams.getAll("ranges")).toEqual([
      "'Copy of Google'!$Z$2:$Z$8",
      "OwnerList",
    ]);
    expect(structure.validations).toEqual({
      status: { options: ["Open", "Done"], source: "=$Z$2:$Z$8" },
      owner: { options: ["Pragaman"], source: "=OwnerList" },
    });
  });

  it("lists only grid tabs: a chart sheet can never become a tracker (11 step 2)", async () => {
    const { source, calls } = fakeGoogle([
      [
        /fields=sheets\.properties/,
        () => ({
          sheets: [
            ...TABS.sheets,
            {
              properties: { sheetId: 9, title: "Chart1", sheetType: "OBJECT" },
            },
          ],
        }),
      ],
    ]);
    expect(await source.listTabs("sheet-1")).toEqual([
      { sheetId: 7, title: "Copy of Google", rowCount: 40, columnCount: 12 },
    ]);
    expect(calls[0]!.url.searchParams.get("fields")).toBe(
      "sheets.properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount))",
    );
    await expect(
      source.readTopRows({ fileId: "sheet-1", sheetId: 9 }, 10),
    ).rejects.toMatchObject({ code: "tab_not_found" });
  });

  it("looks a tab's title up once per job, not once per call (7.4 quotas)", async () => {
    let clock = 1_000_000;
    const { source, calls } = fakeGoogle(
      [
        [/fields=sheets\.properties/, () => TABS],
        [
          /includeGridData=true/,
          () => ({
            sheets: [
              {
                properties: { sheetId: 7 },
                data: [{ rowData: [{ values: [typed("Status")] }] }],
              },
            ],
          }),
        ],
        [
          /values:batchGet/,
          () => ({ valueRanges: [{ values: [["Status"]] }] }),
        ],
        [/values\/.*!1:1/, () => ({ values: [["Status"]] })],
        [/values:batchUpdate/, () => ({})],
      ],
      { now: () => clock },
    );
    const lookups = () =>
      calls.filter(
        (c) =>
          c.url.searchParams.has("fields") && !c.url.searchParams.has("ranges"),
      ).length;
    await source.readStructure(ref, 1);
    await source.readRows(ref, 1);
    await source.writeCells(ref, 1, [
      { row: 2, header: "Status", kind: "text", value: "Done" },
    ]);
    await source.readRows(ref, 1);
    expect(lookups()).toBe(1);
    clock += 60_000;
    await source.readRows(ref, 1);
    expect(lookups()).toBe(2);
  });

  it("looks the title up again when the tab was renamed since (7.4: tabs are kept by sheetId)", async () => {
    let title = "Old";
    const { source, calls } = fakeGoogle([
      [
        /fields=sheets\.properties/,
        () => ({
          sheets: [{ properties: { ...TABS.sheets[0]!.properties, title } }],
        }),
      ],
      [
        /values:batchGet/,
        (url) =>
          url.searchParams.get("ranges") === `'${title}'!A1:ZZZ`
            ? { valueRanges: [{ values: [["Status"], ["Done"]] }] }
            : badRange(),
      ],
    ]);
    await source.readRows(ref, 1);
    title = "New";
    const rows = await source.readRows(ref, 1);
    expect(rows).toHaveLength(1);
    expect(calls.filter((c) => c.url.searchParams.has("fields"))).toHaveLength(
      2,
    );
  });

  it("reads the structure of the tab by sheetId even when another tab took its old title", async () => {
    let tabs = [{ sheetId: 7, title: "Tasks" }];
    const { source } = fakeGoogle([
      [
        /fields=sheets\.properties/,
        () => ({ sheets: tabs.map((properties) => ({ properties })) }),
      ],
      [
        /includeGridData=true/,
        (url) => {
          const title = /^'(.*)'!/.exec(url.searchParams.get("ranges")!)![1];
          const tab = tabs.find((t) => t.title === title)!;
          return {
            sheets: [
              {
                properties: { sheetId: tab.sheetId },
                data: [
                  {
                    rowData: [
                      {
                        values: [typed(tab.sheetId === 7 ? "Status" : "Other")],
                      },
                    ],
                  },
                ],
              },
            ],
          };
        },
      ],
    ]);
    await source.readStructure(ref, 1);
    // Swapped within seconds: "Tasks" now names another tab.
    tabs = [
      { sheetId: 7, title: "Tasks2" },
      { sheetId: 9, title: "Tasks" },
    ];
    const structure = await source.readStructure(ref, 1);
    expect(structure.headers.map((h) => h.header)).toEqual(["Status"]);
  });
});

describe("GoogleArchive (PRD 10.7)", () => {
  const archiveRows = {
    taskDays: [["2026-09-28", "td-1"]],
    events: [["2026-09-28", "ev-1"]],
  };

  it("creates the missing tabs and their header rows in one batch", async () => {
    const { calls, api } = fakeGoogle([
      [
        /fields=sheets\.properties/,
        () => ({ sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] }),
      ],
      [/values\/.*A:A/, () => ({ values: [] })],
      [/:batchUpdate$/, () => ({})],
      [/:append/, () => ({})],
    ]);
    await new GoogleArchive("archive-1", api).replaceDay(
      "2026-09-28",
      archiveRows,
    );
    const batches = calls.filter((c) =>
      c.url.pathname.endsWith(":batchUpdate"),
    );
    expect(batches).toHaveLength(1);
    const requests = (
      batches[0]!.body as { requests: Record<string, unknown>[] }
    ).requests;
    expect(requests.map((r) => Object.keys(r)[0])).toEqual([
      "addSheet",
      "updateCells",
      "addSheet",
      "updateCells",
    ]);
    expect(requests[0]).toEqual({
      addSheet: { properties: { sheetId: 1, title: "task_days" } },
    });
    expect(requests[3]).toMatchObject({
      updateCells: {
        start: { sheetId: 2, rowIndex: 0, columnIndex: 0 },
        fields: "userEnteredValue",
      },
    });
    expect(
      calls.filter((c) => c.url.pathname.includes(":append")),
    ).toHaveLength(2);
  });

  it("never re-sends an append or a delete after a 5xx, so day D is never archived twice", async () => {
    const tabs = {
      sheets: [
        { properties: { sheetId: 1, title: "task_days" } },
        { properties: { sheetId: 2, title: "events" } },
      ],
    };
    const append = fakeGoogle([
      [/fields=sheets\.properties/, () => tabs],
      [/values\/.*A:A/, () => ({ values: [["day"]] })],
      [/:append/, () => new Response("{}", { status: 503 })],
    ]);
    await expect(
      new GoogleArchive("archive-1", append.api).replaceDay(
        "2026-09-28",
        archiveRows,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      append.calls.filter((c) => c.url.pathname.includes(":append")),
    ).toHaveLength(1);

    const remove = fakeGoogle([
      [/fields=sheets\.properties/, () => tabs],
      [/values\/.*A:A/, () => ({ values: [["day"], ["2026-09-28"]] })],
      [/:batchUpdate$/, () => new Response("{}", { status: 504 })],
    ]);
    await expect(
      new GoogleArchive("archive-1", remove.api).replaceDay(
        "2026-09-28",
        archiveRows,
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect(
      remove.calls.filter((c) => c.url.pathname.endsWith(":batchUpdate")),
    ).toHaveLength(1);
  });
});
