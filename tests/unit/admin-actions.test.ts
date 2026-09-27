import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminTracker } from "@/lib/admin/data";
import { TrackerConfig } from "@/lib/domain/config";
import {
  statusChoices,
  statusField,
  type DraftConfig,
} from "@/lib/domain/wizard";
import { MemorySheetSource } from "@/lib/sheets/memory";
import type { TabRef, TabStructure } from "@/lib/sheets/types";
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
  leaseSkipped: false,
  structure: null as unknown,
  sheetTrackers: [] as unknown[],
}));

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
  getCurrentUser: async () => ({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Admin",
    email: "admin@knit.test",
    isAdmin: true,
  }),
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
      trackers: async () => fx.sheetTrackers,
      pullRequests: async () => ({}),
    },
    source: {
      readStructure: async () => fx.structure,
      ensureKnitColumns: async () => ({}),
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
vi.mock("@/lib/sync/discover", () => ({ discover: vi.fn(async () => ({})) }));
vi.mock("@/lib/sync/pull", () => ({
  pullAll: vi.fn(async () => [{ tracker: "t", outcome: "pulled" }]),
  pullTracker: vi.fn(async () => ({ outcome: "pulled" })),
}));
vi.mock("@/lib/sync/push", () => ({ pushDue: vi.fn(async () => ({})) }));
vi.mock("@/lib/sync/recreate-ids", () => ({ recreateKnitIds: vi.fn() }));

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
  fx.leaseSkipped = false;
  fx.tracker = trackerWith("active");
  fx.sheetTrackers = [];
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

  it("goes live today unless a date was saved at step 7 (finding 61)", async () => {
    fx.sheetTrackers = [{}];
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    const update = fx.calls.find(
      (c) => c.table === "trackers" && c.op === "update",
    );
    expect(update?.payload).toMatchObject({ go_live_date: "2026-09-30" });

    fx.calls = [];
    fx.tracker = trackerWith("draft", { ...META, goLiveChosen: true });
    await expect(actions.activateTracker(TRACKER_ID)).rejects.toThrow(
      /redirect:/,
    );
    expect(
      fx.calls.find((c) => c.table === "trackers" && c.op === "update")
        ?.payload,
    ).toMatchObject({ go_live_date: "2026-09-28" });
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
