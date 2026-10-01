import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import { calendarDaysFromRules, type CalendarDay } from "@/lib/domain/calendar";
import { TrackerConfig } from "@/lib/domain/config";
import {
  GO_LIVE_NEEDS_A_DATE,
  statusChoices,
  statusField,
  type DraftConfig,
} from "@/lib/domain/wizard";
import { MemorySheetSource } from "@/lib/sheets/memory";
import {
  columnLetter,
  SheetError,
  type TabRef,
  type TabStructure,
} from "@/lib/sheets/types";
import { loadXlsxFolder } from "@/lib/sheets/xlsx";

// PRD 11, 12.8, 9.3 (audit findings 10, 34, 35, 36, 37, 38, 44, 58, 59, 60, 61, C6): the admin's
// actions, with the database, the sheet and Next.js replaced by fakes that record every call.

// ---------------------------------------------------------------------------------------
// Fakes

type Call = {
  table: string;
  op: string;
  payload?: unknown;
  filters: unknown[];
};
type Result = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number;
};

const fx = vi.hoisted(() => ({
  calls: [] as {
    table: string;
    op: string;
    payload?: unknown;
    filters: unknown[];
  }[],
  rpcs: [] as { fn: string; args: unknown; as: "user" | "service" }[],
  auth: [] as { op: string; args: unknown[] }[],
  results: {} as Record<string, unknown>,
  after: [] as (() => Promise<void>)[],
  tracker: null as unknown,
  tab: null as unknown,
  unmapped: [] as string[],
  today: "2026-09-30",
  /** calendar_days as load_sync_context reads them. */
  calendar: [] as unknown[],
  leaseSkipped: false,
  structure: null as unknown,
  /** Structures read one after another, before `structure` (an Error is thrown). */
  structures: [] as unknown[],
  sheetTrackers: [] as unknown[],
  /** What reached the sheet and the folder, in order. */
  sheet: [] as string[],
  user: null as unknown,
}));

const ADMIN = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Admin",
  email: "admin@knit.test",
  isAdmin: true,
};

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  fx.calls.push(call);
  const settle = (): Result =>
    (fx.results[`${table}.${call.op}`] as Result | undefined) ?? {
      data: null,
      error: null,
    };
  const chain = {
    select: () => chain,
    insert: (payload: unknown) => (
      (call.op = "insert"),
      (call.payload = payload),
      chain
    ),
    update: (payload: unknown) => (
      (call.op = "update"),
      (call.payload = payload),
      chain
    ),
    upsert: (payload: unknown) => (
      (call.op = "upsert"),
      (call.payload = payload),
      chain
    ),
    delete: () => ((call.op = "delete"), chain),
    eq: (...filter: unknown[]) => (call.filters.push(filter), chain),
    neq: () => chain,
    not: () => chain,
    single: async () => settle(),
    maybeSingle: async () => settle(),
    then: (resolve: (r: Result) => unknown) => resolve(settle()),
  };
  return chain;
}

function client(as: "user" | "service") {
  return {
    from: builder,
    rpc: async (fn: string, args: unknown) => {
      fx.rpcs.push({ fn, args, as });
      return (
        (fx.results[`rpc.${fn}`] as Result | undefined) ?? {
          data: null,
          error: null,
        }
      );
    },
    auth: {
      admin: {
        createUser: async (...args: unknown[]) => {
          fx.auth.push({ op: "createUser", args });
          return (
            (fx.results["auth.createUser"] as Result | undefined) ?? {
              data: { user: { id: "00000000-0000-4000-8000-0000000000aa" } },
              error: null,
            }
          );
        },
        deleteUser: async (...args: unknown[]) => {
          fx.auth.push({ op: "deleteUser", args });
          return { data: null, error: null };
        },
        updateUserById: async (...args: unknown[]) => {
          fx.auth.push({ op: "updateUserById", args });
          return (
            (fx.results["auth.updateUserById"] as Result | undefined) ?? {
              data: null,
              error: null,
            }
          );
        },
      },
    },
  };
}

vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => fx.after.push(task),
}));
vi.mock("@/lib/supabase/server", () => ({
  getCurrentUser: async () => fx.user,
  getSupabase: async () => client("user"),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => client("service"),
}));
vi.mock("@/lib/admin/data", () => ({
  loadTracker: async () => fx.tracker,
  loadTabData: async () => fx.tab,
  unmappedStatusWords: async () => fx.unmapped,
  loadSheetDeps: async () => ({
    store: {
      today: async () => fx.today,
      loadContext: async () => ({ calendar: fx.calendar, aliases: [] }),
      trackers: async () => fx.sheetTrackers,
      pullRequests: async () => ({}),
    },
    source: {
      readStructure: async () => {
        fx.sheet.push("readStructure");
        const next =
          fx.structures.length > 0 ? fx.structures.shift() : fx.structure;
        if (next instanceof Error) throw next;
        return next;
      },
      ensureKnitColumns: async () => {
        fx.sheet.push("ensureKnitColumns");
        return {};
      },
    },
  }),
}));
vi.mock("@/lib/jobs/cron", () => ({
  withJobLease: async (
    _job: string,
    _ttl: number,
    work: (deps: unknown) => Promise<unknown>,
  ) =>
    fx.leaseSkipped
      ? { skipped: true }
      : { skipped: false, result: await work({ deadline: 0 }) },
}));
vi.mock("@/lib/sync/discover", () => ({
  discover: vi.fn(async () => {
    fx.sheet.push("discover");
    return {};
  }),
}));
vi.mock("@/lib/sync/pull", () => ({
  pullAll: vi.fn(async () => [{ tracker: "t", outcome: "pulled" }]),
  pullTracker: vi.fn(async () => ({ outcome: "pulled" })),
}));
vi.mock("@/lib/sync/push", () => ({ pushDue: vi.fn(async () => ({})) }));
vi.mock("@/lib/sync/recreate-ids", () => ({
  recreateKnitIds: vi.fn(async () => {
    fx.sheet.push("recreateKnitIds");
    return { written: 3, cleared: 0 };
  }),
}));

const actions = await import("@/lib/actions/admin");

// ---------------------------------------------------------------------------------------
// The Filing Buddy Meta Ads example tracker

const registry = (
  await import("../../fixtures/trackers.config.json", {
    with: { type: "json" },
  })
).default as { trackers: Record<string, unknown>[] };
const META = TrackerConfig.parse(
  registry.trackers.find((t) => t.name === "Filing Buddy · Meta Ads"),
);
const source = new MemorySheetSource(
  loadXlsxFolder(
    fileURLToPath(new URL("../../fixtures/trackers", import.meta.url)),
  ),
);
const FILE = "Filing_Buddy_Meta_Ads_Tracker";
const ref: TabRef = {
  fileId: FILE,
  sheetId: (await source.listTabs(FILE)).find(
    (t) => t.title === "Copy of Meta",
  )!.sheetId,
};
const structure: TabStructure = await source.readStructure(ref, 1);
const rows = await source.readRows(ref, 1);

const TRACKER_ID = "00000000-0000-4000-8000-0000000000f1";
const holidays = (
  await import("../../fixtures/holidays.json", { with: { type: "json" } })
).default.holidays;
const calendarTo = (last: string): CalendarDay[] =>
  calendarDaysFromRules(holidays, "2026-09-01", last);

function trackerWith(
  state: AdminTracker["state"],
  draft: DraftConfig = { ...META },
): AdminTracker {
  return {
    id: TRACKER_ID,
    fileId: FILE,
    gid: ref.sheetId,
    tabName: "Copy of Meta",
    name: "Meta Ads",
    color: "amber",
    state,
    pauseReason: null,
    draft,
    goLiveDate: "2026-09-28",
    lastPullAt: null,
    ownerUserId: null,
    ref,
  };
}

/** The columns form as the wizard posts it, with some fields changed. */
function columnsForm(change: Record<string, string> = {}) {
  const form = new FormData();
  const fields: Record<string, string> = {
    date: "Date",
    title: "Task",
    statusRead: "Status",
    statusWrite: "Status",
    completedOn: "Done on",
    completedOnFormat: "text",
    completedOnPattern: "EEE d MMM",
    owner: "Owner",
    sourceRef: "ID",
    critical: "Blocks go-live?",
    criticalTruthy: "Yes",
    titleTemplate: "{Task}",
    ...change,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

/** The statuses form: every word of `header` mapped, and the given write-backs. */
const wordsOf = (header: string) =>
  statusChoices(
    rows,
    header,
    structure.validations[header.toLowerCase()]?.options ?? null,
  ).map((choice) => choice.key);

function statusesForm(header: string, writeBack: Record<string, string>) {
  const form = new FormData();
  for (const key of wordsOf(header)) form.set(statusField(key), "yet_to_start");
  for (const [status, value] of Object.entries(writeBack))
    form.set(`writeBack:${status}`, value);
  return form;
}

const savedConfigs = () =>
  fx.calls
    .filter((c) => c.table === "trackers" && c.op === "update")
    .map((c) => (c.payload as { config?: DraftConfig }).config);
const rpcNames = () => fx.rpcs.map((r) => r.fn);

beforeEach(() => {
  fx.calls = [];
  fx.rpcs = [];
  fx.auth = [];
  fx.results = {};
  fx.after = [];
  fx.tab = { structure, rows };
  fx.structure = structure;
  fx.unmapped = [];
  fx.today = "2026-09-30";
  fx.calendar = calendarTo("2026-12-31");
  fx.leaseSkipped = false;
  fx.tracker = trackerWith("active");
  fx.sheetTrackers = [];
  fx.structures = [];
  fx.sheet = [];
  fx.user = ADMIN;
});

// ---------------------------------------------------------------------------------------

describe("map columns (11 step 4)", () => {
  it("a draft whose status column changes maps its statuses again (finding 10)", async () => {
    fx.tracker = trackerWith("draft");
    await expect(
      actions.saveColumns(
        TRACKER_ID,
        { error: null },
        columnsForm({ statusRead: "Phase" }),
      ),
    ).rejects.toThrow(/redirect:.*\/setup\/statuses$/);
    const [config] = savedConfigs();
    expect(config?.columns?.statusRead).toBe("Phase");
    expect(config?.statusMap).toBeUndefined();
    expect(config?.writeBack).toEqual(META.writeBack);
  });

  it("a live tracker keeps its status columns until the new words are mapped (finding 10)", async () => {
    await expect(
      actions.saveColumns(
        TRACKER_ID,
        { error: null },
        columnsForm({ statusRead: "Phase" }),
      ),
    ).rejects.toThrow(
      /redirect:\/admin\/trackers\/.+\/setup\/statuses\?statusRead=Phase&statusWrite=Status$/,
    );
    const [config] = savedConfigs();
    expect(config?.columns?.statusRead).toBe("Status");
    expect(config?.statusMap).toEqual(META.statusMap);
  });

  it("refuses a content column as a write target (finding 35)", async () => {
    const result = await actions.saveColumns(
      TRACKER_ID,
      { error: null },
      columnsForm({ completedOn: "Date" }),
    );
    expect(result.error).toMatch(/"Date" is the planned date/);
    expect(savedConfigs()).toEqual([]);
  });

  it("saves the End date column, or null for No end date column (N64)", async () => {
    fx.tracker = trackerWith("draft");
    await expect(
      actions.saveColumns(
        TRACKER_ID,
        { error: null },
        columnsForm({ endDate: "Notes" }),
      ),
    ).rejects.toThrow(/redirect:/);
    expect(savedConfigs()[0]?.columns?.endDate).toBe("Notes");

    fx.calls = [];
    await expect(
      actions.saveColumns(
        TRACKER_ID,
        { error: null },
        columnsForm({ endDate: "" }),
      ),
    ).rejects.toThrow(/redirect:/);
    expect(savedConfigs()[0]?.columns?.endDate).toBe(null);
  });

  it("refuses the End date as a write target or as the Date column (N64)", async () => {
    fx.tracker = trackerWith("draft");
    const asTarget = await actions.saveColumns(
      TRACKER_ID,
      { error: null },
      columnsForm({ endDate: "Done on" }),
    );
    expect(asTarget.error).toBe(
      '"Done on" is the planned end date, which Knit never changes. Choose another column to write to.',
    );
    const asDate = await actions.saveColumns(
      TRACKER_ID,
      { error: null },
      columnsForm({ endDate: "Date" }),
    );
    expect(asDate.error).toBe("Date and End date must be different columns.");
    expect(savedConfigs()).toEqual([]);
  });

  it("refuses a completed-on pattern Knit cannot read back (finding 36)", async () => {
    const result = await actions.saveColumns(
      TRACKER_ID,
      { error: null },
      columnsForm({ completedOnPattern: "dd/mm/yyyy" }),
    );
    expect(result.error).toMatch(/cannot write dates as "dd\/mm\/yyyy"/);
    expect(savedConfigs()).toEqual([]);
  });
});

describe("map statuses (11 step 5)", () => {
  const writeBack = (value: string) => ({
    yet_to_start: value,
    in_progress: "__leave__",
    blocked: "__leave__",
    done: "__leave__",
    cancelled: "__leave__",
  });

  it("write-back words come from the status write column (finding 34)", async () => {
    fx.tracker = trackerWith("draft", {
      ...META,
      columns: { ...META.columns, statusWrite: "Phase" },
    });
    const refused = await actions.saveStatuses(
      TRACKER_ID,
      { error: null },
      statusesForm("Status", writeBack("Not started")),
    );
    expect(refused.error).toBe(
      'Choose a word that "Phase" accepts, or leave the cell unchanged.',
    );
    const phase = String(rows[0]!.cells.phase!.formatted);
    await expect(
      actions.saveStatuses(
        TRACKER_ID,
        { error: null },
        statusesForm("Status", writeBack(phase)),
      ),
    ).rejects.toThrow(/redirect:/);
    expect(savedConfigs()[0]?.writeBack?.yet_to_start).toBe(phase);
  });

  it("a live tracker's new status column is saved together with its words (finding 10)", async () => {
    const form = statusesForm("Phase", writeBack("__leave__"));
    form.set("pendingStatusRead", "Phase");
    form.set("pendingStatusWrite", "");
    await expect(
      actions.saveStatuses(TRACKER_ID, { error: null }, form),
    ).rejects.toThrow(/redirect:.*saved=1/);
    const [config] = savedConfigs();
    expect(config?.columns).toMatchObject({
      statusRead: "Phase",
      statusWrite: null,
    });
    expect(Object.values(config!.statusMap!)).toContain("yet_to_start");
    // Saving pulls the tracker again (11): after the response.
    expect(fx.after).toHaveLength(1);
  });

  it("a live tracker's status column never changes without its words (finding 10)", async () => {
    const form = statusesForm("Phase", writeBack("__leave__"));
    form.delete(statusField(wordsOf("Phase")[0]!)); // one word left unmapped
    form.set("pendingStatusRead", "Phase");
    form.set("pendingStatusWrite", "");
    const result = await actions.saveStatuses(
      TRACKER_ID,
      { error: null },
      form,
    );
    expect(result.error).toBe("Choose a Knit status for every word.");
    expect(savedConfigs()).toEqual([]);
  });
});

describe("activate (11 step 9)", () => {
  beforeEach(() => {
    fx.tracker = trackerWith("draft");
  });

  it("is refused while a word of the status column is unmapped (finding 10)", async () => {
    fx.unmapped = ["Posted"];
    const result = await actions.activateTracker(TRACKER_ID);
    expect(result.error).toBe(
      "Choose a Knit status for every word. Not mapped yet: Posted.",
    );
    expect(savedConfigs()).toEqual([]);
    expect(rpcNames()).not.toContain("set_tracker_state");
  });

  const goLiveWritten = () =>
    fx.calls.find((c) => c.table === "trackers" && c.op === "update")
      ?.payload as { go_live_date?: string } | undefined;

  it("goes live on the next working day unless a date was saved at step 7 (N42)", async () => {
    fx.sheetTrackers = [{}];
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    expect(goLiveWritten()).toMatchObject({ go_live_date: "2026-10-01" });

    // Thu 1 Oct: 2 Oct is Gandhi Jayanti, 3 Oct a 1st Saturday (a working day).
    fx.calls = [];
    fx.today = "2026-10-01";
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    expect(goLiveWritten()).toMatchObject({ go_live_date: "2026-10-03" });

    fx.calls = [];
    fx.tracker = trackerWith("draft", { ...META, goLiveChosen: true });
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    expect(goLiveWritten()).toMatchObject({ go_live_date: "2026-09-28" });
  });

  it("asks for a date at step 7, writing nothing, when the calendar has no next working day (N42)", async () => {
    fx.sheetTrackers = [{}];
    fx.calendar = calendarTo("2026-09-30");
    const result = await actions.activateTracker(TRACKER_ID);
    expect(result.error).toBe(GO_LIVE_NEEDS_A_DATE);
    expect(goLiveWritten()).toBeUndefined();
    expect(fx.sheet).not.toContain("ensureKnitColumns");
    expect(rpcNames()).not.toContain("set_tracker_state");
  });

  it("uses a saved date even when the calendar has no next working day (N19 b)", async () => {
    fx.sheetTrackers = [{}];
    fx.calendar = calendarTo("2026-09-30");
    fx.tracker = trackerWith("draft", { ...META, goLiveChosen: true });
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    expect(goLiveWritten()).toMatchObject({ go_live_date: "2026-09-28" });
    expect(fx.sheet).toContain("ensureKnitColumns");
  });
});

describe("resume (finding 38)", () => {
  const paused = {
    id: TRACKER_ID,
    fileId: FILE,
    sheetGid: ref.sheetId,
    config: META,
  };

  beforeEach(() => {
    fx.sheetTrackers = [paused];
    fx.results["drive_files.select"] = { data: { state: "connected" } };
  });

  it("is refused while the sheet is outside the Knit folder", async () => {
    fx.results["drive_files.select"] = { data: { state: "left_folder" } };
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual({
      error: "The sheet is not in the Knit folder. Move it back, then Resume.",
    });
    expect(rpcNames()).not.toContain("set_tracker_state");
    expect(fx.after).toEqual([]);
  });

  it("is refused while the Knit ID column is missing, so no held write-back is released", async () => {
    fx.structure = {
      ...structure,
      headers: structure.headers.filter((h) => h.normalised !== "knit id"),
    };
    const result = await actions.resumeTracker(TRACKER_ID);
    expect(result.error).toMatch(/the Knit ID column is missing/);
    expect(rpcNames()).not.toContain("set_tracker_state");
    expect(fx.after).toEqual([]);
  });

  it("resumes a tracker whose tab matches again, then pulls and pushes", async () => {
    fx.structure = await source.readStructure(ref, 1);
    await source.ensureKnitColumns(ref, 1);
    fx.structure = await source.readStructure(ref, 1);
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual({ error: null });
    expect(fx.rpcs).toContainEqual(
      expect.objectContaining({
        fn: "set_tracker_state",
        args: expect.objectContaining({ p_state: "active" }),
        as: "service",
      }),
    );
    expect(fx.after).toHaveLength(2);
  });

  it("says the sheet or tab cannot be found, not to wait a minute (review R13)", async () => {
    fx.structure = new SheetError("No tab 7 in the sheet", "tab_not_found");
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual({
      error:
        "Knit cannot resume yet: the sheet or tab cannot be found. Restore the sheet or its tab, then Resume.",
    });
    expect(rpcNames()).not.toContain("set_tracker_state");
  });

  it("still asks to try again in a minute when Google fails for a moment", async () => {
    fx.structure = new SheetError("Google answered 503", "api_error", 503);
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual({
      error: "Knit could not check the sheet. Try again in a minute.",
    });
  });
});

/** The Meta Ads tab as the structure check sees it, with Knit's columns and some changes. */
function tabWith(
  options: { knitId?: boolean; formulas?: string[]; doubled?: string[] } = {},
): TabStructure {
  const base = structure.headers.filter(
    (h) => h.normalised !== "knit id" && h.normalised !== "knit note",
  );
  const knit = [
    ...(options.knitId === false ? [] : ["Knit ID"]),
    "Knit Note",
  ].map((header, i) => ({
    index: base.length + i,
    letter: columnLetter(base.length + i),
    header,
    normalised: header.toLowerCase(),
  }));
  return {
    ...structure,
    headers: [...base, ...knit],
    formulaColumns: [...structure.formulaColumns, ...(options.formulas ?? [])],
    duplicateHeaders: [
      ...structure.duplicateHeaders,
      ...(options.doubled ?? []),
    ],
  };
}

describe("recreate the Knit ID column (14, N43, reviews R6 and R16)", () => {
  const paused = {
    id: TRACKER_ID,
    fileId: FILE,
    sheetGid: ref.sheetId,
    config: META,
  };
  const resumed = () =>
    fx.rpcs.some(
      (r) =>
        r.fn === "set_tracker_state" &&
        (r.args as { p_state: string }).p_state === "active",
    );

  beforeEach(() => {
    fx.sheetTrackers = [paused];
    fx.results["drive_files.select"] = { data: { state: "connected" } };
    fx.structure = tabWith();
  });

  it("recreates and resumes a tab whose only problem is the missing Knit ID column", async () => {
    fx.structures = [tabWith({ knitId: false })];
    expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual({
      error: null,
      notice: "Recreated 3 Knit IDs.",
    });
    expect(fx.sheet).toEqual([
      "discover",
      "readStructure",
      "ensureKnitColumns",
      "readStructure",
      "recreateKnitIds",
    ]);
    expect(resumed()).toBe(true);
  });

  it("writes nothing to a sheet outside the Knit folder (D14)", async () => {
    fx.results["drive_files.select"] = { data: { state: "left_folder" } };
    fx.structures = [tabWith({ knitId: false })];
    expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual({
      error: "The sheet is not in the Knit folder. Move it back, then Resume.",
    });
    expect(fx.sheet).toEqual(["discover"]);
    expect(resumed()).toBe(false);
  });

  it("says the sheet is outside the folder when the database refuses to resume it", async () => {
    fx.structures = [tabWith({ knitId: false })];
    fx.results["rpc.set_tracker_state"] = {
      error: { message: "file_outside_folder" },
    };
    expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual({
      error: "The sheet is not in the Knit folder. Move it back, then Resume.",
    });
  });

  it.each([
    [
      "holds formulas",
      tabWith({ formulas: ["knit id"] }),
      "column 'Knit ID' holds formulas and cannot be written",
    ],
    [
      "appears twice",
      tabWith({ doubled: ["knit id"] }),
      "column 'Knit ID' appears more than once",
    ],
  ])(
    "never writes to a Knit ID column that %s (invariant 2, N39)",
    async (_case, tab, reason) => {
      fx.structure = tab;
      expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual({
        error: `Knit cannot recreate the Knit ID column yet: ${reason}. Fix the sheet or Edit mapping, then try again.`,
      });
      expect(fx.sheet).toEqual(["discover", "readStructure"]);
      expect(resumed()).toBe(false);
    },
  );

  it("checks the tab again once the columns are added, and resumes only when it passes", async () => {
    fx.structures = [
      tabWith({ knitId: false }),
      tabWith({ formulas: ["knit id"] }),
    ];
    const result = await actions.recreateKnitIdColumn(TRACKER_ID);
    expect(result.error).toMatch(/holds formulas/);
    expect(fx.sheet).not.toContain("recreateKnitIds");
    expect(resumed()).toBe(false);
  });

  it("says the sheet or tab cannot be found", async () => {
    fx.structure = new SheetError("No tab 7 in the sheet", "tab_not_found");
    expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual({
      error:
        "Knit cannot recreate the Knit ID column yet: the sheet or tab cannot be found. Restore the sheet or its tab, then try again.",
    });
  });
});

describe("pause and archive (review R12)", () => {
  it("say in plain language when the database refuses the change", async () => {
    fx.results["rpc.set_tracker_state"] = {
      error: { message: "invalid_transition" },
    };
    expect(await actions.pauseTracker(TRACKER_ID)).toEqual({
      error: "The tracker could not be paused. Reload the page and try again.",
    });
    expect(await actions.archiveTracker(TRACKER_ID)).toEqual({
      error:
        "The tracker could not be archived. Reload the page and try again.",
    });
  });
});

describe("a caller who is not the signed-in admin (review R14)", () => {
  const SIGNED_OUT = { error: "Your session has ended. Sign in again." };
  const NOT_ADMIN = { error: "Only the admin can do this." };
  const USER = "00000000-0000-4000-8000-000000000002";

  it("is told to sign in again when the session has ended", async () => {
    fx.user = null;
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual(SIGNED_OUT);
    expect(await actions.recreateKnitIdColumn(TRACKER_ID)).toEqual(SIGNED_OUT);
    expect(await actions.startSetup(FILE, ref.sheetId)).toEqual(SIGNED_OUT);
    expect(await actions.setUserActive(USER, false)).toEqual(SIGNED_OUT);
    expect(
      await actions.saveColumns(TRACKER_ID, { error: null }, columnsForm()),
    ).toEqual(SIGNED_OUT);
    expect(fx.calls).toEqual([]);
    expect(fx.rpcs).toEqual([]);
    expect(fx.sheet).toEqual([]);
  });

  it("is told only the admin can do this when signed in as a member", async () => {
    fx.user = { ...ADMIN, id: USER, isAdmin: false };
    expect(await actions.resumeTracker(TRACKER_ID)).toEqual(NOT_ADMIN);
    expect(await actions.startSetup(FILE, ref.sheetId)).toEqual(NOT_ADMIN);
    expect(await actions.setUserActive(USER, false)).toEqual(NOT_ADMIN);
    expect(fx.calls).toEqual([]);
  });
});

describe("Sync now for one tracker (findings 37, 44)", () => {
  it("says so when another pull holds the lease", async () => {
    fx.leaseSkipped = true;
    expect(await actions.syncTracker(TRACKER_ID)).toEqual({
      error: "A pull is already running. Try again in a minute.",
    });
  });
});

describe("inputs are validated (finding 59)", () => {
  const INVALID = {
    error: "This is no longer valid. Reload the page and try again.",
  };

  it("refuses bound arguments of the wrong type", async () => {
    const loose = actions as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    expect(
      await loose.setUserActive!(
        "00000000-0000-4000-8000-000000000002",
        "false",
      ),
    ).toEqual(INVALID);
    expect(await loose.startSetup!("file", "123")).toEqual(INVALID);
    expect(await loose.retryWrites!("x")).toEqual(INVALID);
    expect(await loose.pauseTracker!("not-a-uuid")).toEqual(INVALID);
    expect(await loose.setAttentionState!("1", "resolved")).toEqual(INVALID);
    expect(await loose.setFileIgnored!("file", "yes")).toEqual(INVALID);
    expect(
      await loose.mapStatusWord!(
        1,
        "not-a-uuid",
        "Posted",
        { error: null },
        new FormData(),
      ),
    ).toEqual(INVALID);
    expect(
      await loose.linkOwnerName!(42, null, { error: null }, new FormData()),
    ).toEqual(INVALID);
    expect(
      await loose.resetPassword!("x", { error: null }, new FormData()),
    ).toEqual(INVALID);
    expect(fx.auth).toEqual([]);
    expect(fx.rpcs).toEqual([]);
    expect(fx.calls).toEqual([]);
  });
});

describe("people (findings 58, 60)", () => {
  const USER = "00000000-0000-4000-8000-000000000002";

  function userForm(alias = "") {
    const form = new FormData();
    form.set("name", "Asha");
    form.set("email", "asha@knit.test");
    form.set("role", "member");
    form.set("password", "a-long-test-password");
    form.set("alias", alias);
    return form;
  }

  it("a user whose row cannot be saved is not left behind as a login", async () => {
    fx.results["app_users.insert"] = { error: { message: "boom" } };
    expect(await actions.createUser({ error: null }, userForm())).toEqual({
      error: "The user could not be saved. Try again.",
    });
    expect(fx.auth.map((a) => a.op)).toEqual(["createUser", "deleteUser"]);
  });

  it("says when the name in trackers could not be saved", async () => {
    fx.results["people_aliases.upsert"] = { error: { message: "boom" } };
    const result = await actions.createUser({ error: null }, userForm("Asha"));
    expect(result.notice).toBe(
      "Created asha@knit.test, but the name in trackers could not be saved. Add it under Names in trackers.",
    );
  });

  it("deactivating ends access first, then blocks the sign-in", async () => {
    expect(await actions.setUserActive(USER, false)).toEqual({ error: null });
    const order = [...fx.calls.map(() => "row"), ...fx.auth.map(() => "login")];
    expect(order).toEqual(["row", "login"]);
    expect(fx.calls[0]?.payload).toEqual({ is_active: false });
  });

  it("reactivating marks the user active only once the sign-in works again", async () => {
    fx.results["auth.updateUserById"] = {
      data: null,
      error: { message: "rate limited" },
    };
    expect(await actions.setUserActive(USER, true)).toEqual({
      error: "The account could not be reactivated. Try again.",
    });
    expect(fx.calls).toEqual([]);
  });

  it("the admin cannot deactivate themselves (N19 f)", async () => {
    expect(
      await actions.setUserActive(
        "00000000-0000-4000-8000-000000000001",
        false,
      ),
    ).toEqual({ error: "You cannot deactivate your own account." });
    expect(fx.auth).toEqual([]);
  });
});

describe("holidays (N19 g, finding C6)", () => {
  function holidayForm(confirm?: string) {
    const form = new FormData();
    form.set("day", "2026-10-05");
    form.set("name", "Office closed");
    if (confirm !== undefined) form.set("confirm", confirm);
    return form;
  }

  beforeEach(() => {
    fx.results["rpc.holiday_impact"] = {
      data: { openTaskDays: 3, plannedTasks: 1, lockedTaskDays: 0 },
    };
  });

  const saved = () =>
    fx.calls.filter((c) => c.table === "holidays" && c.op === "upsert");

  it("asks to confirm the number of open tasks before saving", async () => {
    const result = await actions.addHoliday({ error: null }, holidayForm());
    expect(result).toMatchObject({ confirm: 3 });
    expect(result.error).toMatch(/^3 open tasks are on or planned/);
    expect(saved()).toEqual([]);
  });

  it("saves only when the confirmed number is still the number of open tasks", async () => {
    await actions.addHoliday({ error: null }, holidayForm("1"));
    expect(saved()).toEqual([]);
    expect(await actions.addHoliday({ error: null }, holidayForm("3"))).toEqual(
      { error: null, notice: "Saved Office closed." },
    );
    expect(saved()).toHaveLength(1);
  });

  it("does not save when the open tasks cannot be counted", async () => {
    fx.results["rpc.holiday_impact"] = { data: null, error: { message: "x" } };
    const result = await actions.addHoliday({ error: null }, holidayForm("3"));
    expect(result.error).toMatch(/could not count/);
    expect(saved()).toEqual([]);
  });
});

// The standard example (11.1), for Use the standard setup.
const STD = "Knit_Standard_Tracker_v1_example";
const stdRef: TabRef = {
  fileId: STD,
  sheetId: (await source.listTabs(STD)).find((t) => t.title === "Tasks")!
    .sheetId,
};
const stdStructure = await source.readStructure(stdRef, 1);
const stdRows = await source.readRows(stdRef, 1);

describe("Use the standard setup (11.1, N68, N69)", () => {
  const TEMPLATE = "knit-standard-v1";
  const apply = (trackerId = TRACKER_ID, templateId = TEMPLATE) =>
    actions.applyStandardSetup(
      trackerId,
      templateId,
      { error: null },
      new FormData(),
    );
  const INVALID = {
    error: "This is no longer valid. Reload the page and try again.",
  };

  beforeEach(() => {
    fx.tracker = trackerWith("draft", { goLiveChosen: true });
    fx.tab = { structure: stdStructure, rows: stdRows };
  });

  it("is refused to a signed-out caller, a member, bad arguments and a live tracker", async () => {
    fx.user = null;
    expect(await apply()).toEqual({
      error: "Your session has ended. Sign in again.",
    });
    fx.user = { ...ADMIN, isAdmin: false };
    expect(await apply()).toEqual({ error: "Only the admin can do this." });
    fx.user = ADMIN;
    expect(await apply("not-a-uuid")).toEqual(INVALID);
    expect(await apply(TRACKER_ID, "knit-standard-v9")).toEqual(INVALID);
    fx.tracker = trackerWith("active");
    expect(await apply()).toEqual({
      error: "Only a tracker being set up can use the standard setup.",
    });
    expect(savedConfigs()).toEqual([]);
  });

  it("fills the draft from the template and opens Owners and policies", async () => {
    await expect(apply()).rejects.toThrow(
      /^redirect:\/admin\/trackers\/[0-9a-f-]+\/setup\/owners\?standard=applied$/,
    );
    const [config] = savedConfigs();
    const expected = TrackerConfig.parse(
      registry.trackers.find((t) => t.name === "Knit Standard · Example"),
    );
    expect(config).toMatchObject({
      headerRow: 1,
      columns: expected.columns,
      statusMap: expected.statusMap,
      writeBack: expected.writeBack,
      subtitleTemplate: expected.subtitleTemplate,
      detailColumns: expected.detailColumns,
      completedOnFormat: { type: "date" },
      cancelReasons: {},
      // Step 7's choice is not the preset's.
      goLiveChosen: true,
    });
  });

  it("opens Map statuses when a word is left, with no sheet word in the URL", async () => {
    const rows = stdRows.map((row, i) =>
      i === 0
        ? {
            ...row,
            cells: {
              ...row.cells,
              status: { value: "Skipped", formatted: "Skipped" },
            },
          }
        : row,
    );
    fx.tab = { structure: stdStructure, rows };
    const error = await apply().catch((e: Error) => e);
    expect(String(error)).toMatch(
      /redirect:\/admin\/trackers\/[0-9a-f-]+\/setup\/statuses\?standard=applied$/,
    );
    expect(String(error)).not.toMatch(/skipped/i);
    expect(savedConfigs()[0]?.statusMap?.skipped).toBeUndefined();
  });

  it("says so, and saves nothing, when row 1 no longer has the template's headers", async () => {
    fx.tab = { structure, rows };
    expect(await apply()).toEqual({
      error:
        "This tab no longer has the Knit Standard Tracker v1 columns in row 1. Set it up step by step.",
    });
    fx.tab = {
      structure: { ...stdStructure, formulaColumns: ["done on"] },
      rows: stdRows,
    };
    expect((await apply()).error).toMatch(/"Done on" holds formulas/);
    expect(savedConfigs()).toEqual([]);
  });

  it("saving Map statuses again keeps the mapped blank though no row is blank (N69)", async () => {
    const expected = TrackerConfig.parse(
      registry.trackers.find((t) => t.name === "Knit Standard · Example"),
    );
    fx.tracker = trackerWith("draft", { ...expected });
    const noBlank = stdRows.filter(
      (row) => String(row.cells.status?.formatted ?? "") !== "",
    );
    fx.tab = { structure: stdStructure, rows: noBlank };
    const form = new FormData();
    for (const choice of statusChoices(
      noBlank,
      "Status",
      stdStructure.validations.status?.options ?? null,
      { mappedBlank: true },
    ))
      form.set(statusField(choice.key), expected.statusMap[choice.key]!);
    for (const [status, value] of Object.entries(expected.writeBack))
      form.set(`writeBack:${status}`, value!);
    await expect(
      actions.saveStatuses(TRACKER_ID, { error: null }, form),
    ).rejects.toThrow(/redirect:/);
    expect(savedConfigs()[0]?.statusMap?.[""]).toBe("yet_to_start");
  });
});
