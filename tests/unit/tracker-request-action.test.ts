import { fileURLToPath } from "node:url";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { calendarDaysFromRules } from "@/lib/domain/calendar";
import { MemorySheetSource } from "@/lib/sheets/memory";
import { GOOGLE_SHEET_MIME, SheetError } from "@/lib/sheets/types";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD N83 to N88, 13: the action behind Check and send. The database, Google and Next.js are
// fakes that record every call, so the order of the checks shows: no Google read for a
// refusal the database answers, the template, a throttled check or a bad link; a deadline on
// the sheet reads only; never a thrown error; logs with codes only.

type Result = {
  data?: unknown;
  error?: { code?: string; message: string } | null;
};

const fx = vi.hoisted(() => ({
  user: null as unknown,
  template: null as unknown,
  results: {} as Record<string, unknown>,
  rpcs: [] as { fn: string; args: unknown; as: "user" | "service" }[],
  reads: [] as string[],
  google: [] as string[],
  runs: [] as string[],
  discoverError: null as unknown,
  source: null as unknown,
  refreshed: 0,
}));

function client(as: "user" | "service") {
  return {
    from: (table: string) => {
      fx.reads.push(table);
      const settle = () =>
        (fx.results[table] as Result | undefined) ?? {
          data: null,
          error: null,
        };
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => settle(),
        then: (resolve: (r: Result) => unknown) => resolve(settle()),
      };
      return chain;
    },
    rpc: async (fn: string, args?: unknown) => {
      fx.rpcs.push({ fn, args, as });
      return (
        (fx.results[`rpc.${fn}`] as Result | undefined) ?? {
          data: null,
          error: null,
        }
      );
    },
  };
}

vi.mock("next/cache", () => ({
  refresh: () => {
    fx.refreshed += 1;
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getCurrentUser: async () => fx.user,
  getSupabase: async () => client("user"),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => client("service"),
}));
vi.mock("@/lib/guide", () => ({ loadTemplateLink: async () => fx.template }));
vi.mock("@/lib/sync/discover", () => ({
  discover: async () => {
    fx.runs.push("discover started");
    if (fx.discoverError) {
      fx.runs.push("discover finished (failed)");
      throw fx.discoverError;
    }
    fx.runs.push("discover finished");
    return {};
  },
}));
vi.mock("@/lib/jobs/cron", () => ({
  jobDeps: async () => ({
    store: {
      today: async () => "2026-10-04",
      loadContext: async () => ({
        calendar: CALENDAR,
        aliases: [{ aliasNorm: "pragaman", userId: "u-p" }],
      }),
    },
    source: fx.source,
  }),
}));

const holidays = (
  await import("../../fixtures/holidays.json", { with: { type: "json" } })
).default.holidays;
const CALENDAR = calendarDaysFromRules(holidays, "2026-01-01", "2027-12-31");

const { requestTracker } = await import("@/lib/actions/tracker-requests");

const FILE = "Knit_Standard_Tracker_v2_example";
const LINK = `https://docs.google.com/spreadsheets/u/1/d/${FILE}/edit#gid=0`;
const NOTE = "Brand Zeta, Shlok runs it";
const USER = {
  id: "00000000-0000-4000-8000-000000000007",
  name: "Shlok",
  email: "s@knit.test",
  isAdmin: false,
};
const FIXTURES = loadXlsxFolder(
  fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
);

/** The fixture folder as Google, with every read recorded; `stall` never answers it. */
function googleWith(
  options: { stall?: string; fail?: Record<string, unknown> } = {},
) {
  const memory = new MemorySheetSource(structuredClone(FIXTURES));
  return new Proxy(memory, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        fx.google.push(String(prop));
        if (options.stall === prop) return new Promise(() => undefined);
        const failure = options.fail?.[String(prop)];
        if (failure) return Promise.reject(failure);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const send = (
  fields: Record<string, string | Blob> = { url: LINK, note: NOTE },
) => requestTracker({ error: null }, form(fields));

const LISTED = {
  data: {
    name: "Brand Zeta tracker",
    mime_type: GOOGLE_SHEET_MIME,
    state: "new",
  },
  error: null,
};
const rpcNames = () => fx.rpcs.map((r) => r.fn);

let log: MockInstance<typeof console.log>;
const logged = () => log.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  fx.user = USER;
  fx.template = null;
  fx.results = {
    drive_files: LISTED,
    trackers: { data: [], error: null },
    tracker_requests: { data: [], error: null },
    "rpc.claim_tracker_check": { data: true, error: null },
    "rpc.record_tracker_request": {
      data: { outcome: "sent", id: 12 },
      error: null,
    },
  };
  fx.rpcs = [];
  fx.reads = [];
  fx.google = [];
  fx.runs = [];
  fx.discoverError = null;
  fx.source = googleWith();
  fx.refreshed = 0;
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
});

describe("Check and send (N83)", () => {
  it("sends a sheet that passes, with the service role, and says what was sent", async () => {
    const state = await send();
    expect(state).toEqual({
      error: null,
      notice: "Sent to the admin.",
      sent: [
        "Brand Zeta tracker: 10 tasks, in the Knit Standard Tracker v2 layout.",
        // Only Pragaman is known in this fake: Shlok, Aryan and Creative are not (rows).
        expect.stringMatching(/^Rows .* name people Knit does not know yet\./),
      ],
    });
    expect(rpcNames()).toEqual([
      "claim_tracker_check",
      "record_tracker_request",
    ]);
    expect(fx.rpcs[0]!.as).toBe("user");
    const record = fx.rpcs[1]!;
    expect(record.as).toBe("service");
    expect(record.args).toMatchObject({
      p_user_id: USER.id,
      p_file_id: FILE,
      p_sheet_gid: 0,
      p_file_name: "Brand Zeta tracker",
      p_template_id: "knit-standard-v2",
      p_task_count: 10,
      p_note: NOTE,
    });
    expect(fx.runs).toEqual(["discover started", "discover finished"]);
    expect(fx.refreshed).toBe(1);
  });

  it("asks a signed-out caller to sign in again, reading nothing", async () => {
    fx.user = null;
    expect(await send()).toEqual({
      error: "Your session has ended. Sign in again.",
    });
    expect(fx.reads).toEqual([]);
    expect(fx.rpcs).toEqual([]);
    expect(fx.google).toEqual([]);
  });

  it("refuses a bad link, a long note and the blank template without the database or Google", async () => {
    const invalid =
      "Paste the link of a Google Sheet. It starts with https://docs.google.com/spreadsheets/d/";
    expect((await send({ url: "https://example.com/sheet" })).error).toBe(
      invalid,
    );
    expect(
      (await send({ url: new Blob(["x"]) as unknown as string })).error,
    ).toBe(invalid);
    expect((await send({ url: LINK, note: "x".repeat(281) })).error).toBe(
      "Keep the note to 280 characters.",
    );
    expect((await send({ url: LINK, note: "x".repeat(280) })).error).toBeNull();
    fx.rpcs = [];
    fx.reads = [];
    fx.google = [];
    fx.runs = [];
    fx.template = { fileId: FILE, url: "", copyUrl: "" };
    expect((await send()).error).toBe(
      "This is the blank template. Make your own copy with Get the tracker template, fill it in and send the copy's link.",
    );
    expect(fx.rpcs).toEqual([]);
    expect(fx.reads).toEqual([]);
    expect(fx.google).toEqual([]);
    expect(fx.runs).toEqual([]);
  });

  it("refuses a sheet with a tracker or an open request before the limit and Google", async () => {
    const cases: [unknown, string][] = [
      [[{ state: "active" }], "This sheet is already a tracker in Knit."],
      [
        [{ state: "paused" }, { state: "archived" }],
        "This sheet is already a tracker in Knit.",
      ],
      [[{ state: "draft" }], "The admin is already setting up this sheet."],
      [
        [{ state: "archived" }],
        "This sheet was set up in Knit before and then archived. Make a new copy of the template, fill it in and send that.",
      ],
    ];
    for (const [trackers, sentence] of cases) {
      fx.results.trackers = { data: trackers, error: null };
      expect((await send()).error).toBe(sentence);
    }
    fx.results.trackers = { data: [], error: null };
    fx.results.tracker_requests = { data: [{ id: 3 }], error: null };
    expect((await send()).error).toBe(
      "This sheet has already been sent to the admin.",
    );
    expect(fx.rpcs).toEqual([]);
    expect(fx.google).toEqual([]);
    expect(fx.runs).toEqual([]);
  });

  it("gives the limit sentence when the person checked 5 sheets in 10 minutes, reading no Google", async () => {
    fx.results["rpc.claim_tracker_check"] = { data: false, error: null };
    expect((await send()).error).toBe(
      "You have checked 5 sheets in the last 10 minutes. Try again in a few minutes.",
    );
    expect(rpcNames()).toEqual(["claim_tracker_check"]);
    expect(fx.google).toEqual([]);
    expect(fx.runs).toEqual([]);
  });

  it("says where the sheet must be when the listing does not have it, reading no tab", async () => {
    fx.results.drive_files = { data: null, error: null };
    expect((await send()).error).toBe(
      "Knit cannot find this sheet in the Knit folder. Move it into the Knit folder itself, not a folder inside it or a shortcut, or share it with the admin and ask them to move it. Then send the link again.",
    );
    fx.results.drive_files = {
      data: { ...LISTED.data, state: "left_folder" },
      error: null,
    };
    expect((await send()).error).toMatch(/^Knit cannot find this sheet/);
    fx.results.drive_files = {
      data: {
        ...LISTED.data,
        state: "not_a_sheet",
        mime_type: "application/pdf",
      },
      error: null,
    };
    expect((await send()).error).toBe(
      "This file is not a Google Sheet. Open it and use File > Save as Google Sheets, get the new sheet into the Knit folder and send its link.",
    );
    expect(fx.google).toEqual([]);
    expect(rpcNames()).not.toContain("record_tracker_request");
  });

  it("refuses a sheet without a Tasks tab", async () => {
    const sheet = `https://docs.google.com/spreadsheets/d/Sapiens_Example_Tracker/edit`;
    expect((await send({ url: sheet })).error).toBe(
      "This sheet has no Tasks tab. Keep the template's Tasks tab and its name.",
    );
    expect(fx.google).toEqual(["listTabs"]);
  });

  it("lists the findings to fix, saving nothing", async () => {
    const sheet = `https://docs.google.com/spreadsheets/d/Noboru_CA_Campaign_test_example`;
    expect((await send({ url: sheet })).error).toBe(
      "Row 1 of the Tasks tab is not the template's. Keep row 1 exactly as the template has it.",
    );
    const memory = fx.source as MemorySheetSource;
    const tab = memory.files.find((f) => f.id === FILE)!.tabs[0]!;
    tab.rows[2]![0] = { value: null, formatted: "" }; // NOB-02's Task ID
    expect(await send()).toEqual({
      error:
        "Knit cannot send this sheet yet. Fix these in the sheet, then press Check and send again:",
      problems: ["No Task ID: row 3."],
    });
    expect(rpcNames()).not.toContain("record_tracker_request");
  });

  it("says the sheet could not be read when Google fails, saving nothing", async () => {
    fx.source = googleWith({
      fail: {
        listTabs: new SheetError("Sheet x not found", "file_not_found", 404),
      },
    });
    expect((await send()).error).toBe(
      "Knit could not read the sheet just now. Try again in a minute.",
    );
    fx.discoverError = new SheetError(
      "listing failed for folder",
      "api_error",
      503,
    );
    expect((await send()).error).toBe(
      "Knit could not read the sheet just now. Try again in a minute.",
    );
    expect(fx.runs).toContain("discover finished (failed)");
    expect(rpcNames()).not.toContain("record_tracker_request");
  });

  it("stops waiting for the sheet reads 40 s after it started; discover still finished", async () => {
    vi.useFakeTimers();
    fx.source = googleWith({ stall: "readRows" });
    const pending = send();
    await vi.advanceTimersByTimeAsync(39_000);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).error).toBe(
      "Knit could not read the sheet just now. Try again in a minute.",
    );
    expect(fx.runs).toEqual(["discover started", "discover finished"]);
    expect(rpcNames()).not.toContain("record_tracker_request");
    expect(JSON.parse(logged().at(-1)!)).toMatchObject({
      event: "tracker_request.checked",
      outcome: "read_failed",
      code: "timeout",
    });
  });

  it("answers in a sentence when the database fails, and never rejects", async () => {
    fx.results.trackers = {
      data: null,
      error: { code: "PGRST301", message: `JWT for ${FILE} expired` },
    };
    await expect(send()).resolves.toEqual({
      error: "The request could not be sent. Try again.",
    });
    fx.results.trackers = { data: [], error: null };
    fx.results["rpc.record_tracker_request"] = {
      data: null,
      error: {
        code: "23503",
        message: `insert violates foreign key: Key (file_id)=(${FILE}) is not present`,
      },
    };
    await expect(send()).resolves.toEqual({
      error: "The request could not be sent. Try again.",
    });
  });

  it("answers every outcome record_tracker_request can give", async () => {
    const cases: Record<string, string> = {
      not_in_folder:
        "Knit could not read the sheet just now. Try again in a minute.",
      not_a_sheet:
        "This file is not a Google Sheet. Open it and use File > Save as Google Sheets, get the new sheet into the Knit folder and send its link.",
      setting_up: "The admin is already setting up this sheet.",
      already_tracker: "This sheet is already a tracker in Knit.",
      archived:
        "This sheet was set up in Knit before and then archived. Make a new copy of the template, fill it in and send that.",
      already_requested: "This sheet has already been sent to the admin.",
      not_allowed: "The request could not be sent. Try again.",
    };
    for (const [outcome, sentence] of Object.entries(cases)) {
      fx.results["rpc.record_tracker_request"] = {
        data: { outcome },
        error: null,
      };
      expect(await send(), outcome).toEqual({ error: sentence });
    }
    expect(fx.refreshed).toBe(0);
  });
});

describe("logs of a check (N88)", () => {
  it("carry ids, outcomes, counts and codes, never the link, file id, name, note or a message", async () => {
    await send();
    fx.results.drive_files = { data: null, error: null };
    await send();
    fx.results.drive_files = LISTED;
    const memory = fx.source as MemorySheetSource;
    memory.files.find((f) => f.id === FILE)!.tabs[0]!.rows[2]![0] = {
      value: null,
      formatted: "",
    };
    await send();
    fx.results["rpc.record_tracker_request"] = {
      data: null,
      error: {
        code: "23503",
        message: `Key (file_id)=(${FILE}) is not present in table drive_files`,
      },
    };
    memory.files.find((f) => f.id === FILE)!.tabs[0]!.rows[2]![0] = {
      value: "NOB-02",
      formatted: "NOB-02",
    };
    await send();
    fx.source = googleWith({
      fail: {
        listTabs: new SheetError(
          `Sheet ${FILE} not found`,
          "file_not_found",
          404,
        ),
      },
    });
    await send();

    const lines = logged().filter((line) => line.includes("tracker_request."));
    expect(
      lines.map((line) => JSON.parse(line).outcome ?? JSON.parse(line).event),
    ).toEqual([
      "sent",
      "not_in_folder",
      "findings",
      "tracker_request.failed",
      "read_failed",
    ]);
    expect(JSON.parse(lines[2]!)).toMatchObject({
      user: USER.id,
      findings: "no_task_id:1",
    });
    expect(JSON.parse(lines[3]!)).toMatchObject({
      user: USER.id,
      code: "23503",
    });
    expect(JSON.parse(lines[4]!)).toMatchObject({
      code: "file_not_found",
      status: 404,
    });
    for (const line of logged()) {
      for (const secret of [
        FILE,
        LINK,
        NOTE,
        "Brand Zeta",
        "not found",
        "violates",
        "Key (",
      ])
        expect(line, line).not.toContain(secret);
    }
  });
});
