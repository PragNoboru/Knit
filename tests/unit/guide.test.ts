import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ATTENTION_TITLES } from "@/lib/domain/attention";
import { dueLabel, type TaskCard } from "@/lib/domain/cards";
import { GROUP_ORDER, TODAY_TITLES } from "@/lib/domain/day-view";
import {
  parseTemplateLink,
  TEMPLATE_LINK_COPY,
  templateCopyUrl,
  type TemplateLink,
} from "@/lib/domain/guide";
import { KNIT_STANDARD_V2 } from "@/lib/domain/standard-template";
import {
  REQUEST_COPY,
  type MyTrackerRequest,
} from "@/lib/domain/tracker-request";
import { STATUS_LABELS } from "@/lib/domain/status";
import { WIZARD_STEPS } from "@/lib/domain/wizard";

// PRD 12.9 (N77 to N85, N89): the Guide. The template link rules, and what a member's and the
// admin's Guide hold, the form to send a sheet to the admin and the person's own requests.

const fx = vi.hoisted(() => ({
  user: null as unknown,
  template: null as unknown,
  settings: { data: null, error: null } as {
    data: unknown;
    error: { code: string } | null;
  },
  reads: [] as unknown[][],
  requests: { data: [], error: null } as {
    data: unknown;
    error: { code: string } | null;
  },
  requestReads: [] as unknown[][],
}));

vi.mock("@/lib/actions/admin", () => ({ saveTemplateLink: vi.fn() }));
vi.mock("@/lib/actions/tracker-requests", () => ({ requestTracker: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  getCurrentUser: async () => fx.user,
  // N85: the person's own requests, read with their own session.
  getSupabase: async () => ({
    from: (table: string) => {
      const read: unknown[] = [table];
      fx.requestReads.push(read);
      const chain = {
        select: (columns: string) => (read.push(columns), chain),
        eq: (...filter: unknown[]) => (read.push(filter), chain),
        order: (...order: unknown[]) => (read.push(order), chain),
        limit: async (n: number) => (read.push(n), fx.requests),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const read: unknown[] = [table];
      fx.reads.push(read);
      const chain = {
        select: (columns: string) => (read.push(columns), chain),
        eq: (...filter: unknown[]) => (read.push(filter), chain),
        maybeSingle: async () => fx.settings,
      };
      return chain;
    },
  }),
}));

const { Guide } = await import("@/components/guide");
const { loadTemplateLink } = await import("@/lib/guide");

const ID = "1TemplateExampleId_abcdefghijklmnopqrstuvwx";
const SHEET = `https://docs.google.com/spreadsheets/d/${ID}`;
const LINK: TemplateLink = {
  fileId: ID,
  url: SHEET,
  copyUrl: `${SHEET}/copy`,
};

/** Only the fields `dueLabel` reads: an open-ended task from `start`. */
const openEnded = (start: string) =>
  ({ dueDate: null, plannedStart: start, plannedEnd: null }) as TaskCard;

const render = (
  isAdmin: boolean,
  template: TemplateLink | null = null,
  requests: MyTrackerRequest[] = [],
) =>
  renderToStaticMarkup(createElement(Guide, { isAdmin, template, requests }));

/** The section headings, and the contents list's links. */
const headings = (html: string) =>
  [...html.matchAll(/<(h[1-3]|a|p)\b[^>]*>([^<]*)<\/\1>/g)].map((m) =>
    text(m[2]!),
  );

/** The text a reader sees, with the markup and React's entity escapes undone. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">");

const ADMIN_TITLES = [
  "For the admin",
  "Connect a tracker",
  "Whose rows reach Today",
  "People",
  "Needs Attention",
  "Sync health",
  "Holidays",
  "Edit mapping",
  "Pause, Resume, Archive",
  "Corrections and the backlog review",
  "The template's columns",
  "Tracker template link",
];

beforeEach(() => {
  fx.user = null;
  fx.template = null;
  fx.settings = { data: null, error: null };
  fx.reads = [];
  fx.requests = { data: [], error: null };
  fx.requestReads = [];
});

describe("the template link (N80)", () => {
  it("takes a Google Sheets link with anything after the id, and keeps the sheet's plain link", () => {
    for (const input of [
      SHEET,
      `${SHEET}/edit`,
      `${SHEET}/edit#gid=0`,
      `${SHEET}/edit?usp=sharing`,
      `  ${SHEET}/  `,
      `https://DOCS.google.com/spreadsheets/d/${ID}/edit`,
      // A browser signed in to several Google accounts adds /u/{n}/; Knit drops it.
      `https://docs.google.com/spreadsheets/u/0/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=0`,
    ])
      expect(parseTemplateLink(input), input).toEqual(LINK);
  });

  it("refuses anything that is not a Google Sheets link", () => {
    for (const input of [
      "",
      "   ",
      "not a link",
      ID,
      `docs.google.com/spreadsheets/d/${ID}`,
      `http://docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com/document/d/${ID}/edit`,
      `https://drive.google.com/file/d/${ID}/view`,
      `https://docs.google.com.evil.test/spreadsheets/d/${ID}`,
      `https://evil.test/https://docs.google.com/spreadsheets/d/${ID}`,
      `https://user:pass@docs.google.com/spreadsheets/d/${ID}`,
      `https://docs.google.com:8443/spreadsheets/d/${ID}`,
      // Published to the web: /d/e/... is not the file id.
      `https://docs.google.com/spreadsheets/d/e/2PACX-${ID}/pubhtml`,
      "https://docs.google.com/spreadsheets/d/short/edit",
      `https://docs.google.com/spreadsheets/d/${"a".repeat(129)}`,
      `https://docs.google.com/spreadsheets/d/${ID}%2F..%2Fx`,
      `https://docs.google.com/spreadsheets/u/x/d/${ID}/edit`,
      `https://docs.google.com/spreadsheets/u/1/${ID}/edit`,
      `https://docs.google.com/spreadsheets/u/123/d/${ID}/edit`,
      `${SHEET}/edit#${"x".repeat(2000)}`,
    ])
      expect(parseTemplateLink(input), input).toBeNull();
  });

  it("opens Google's make-a-copy page", () => {
    expect(templateCopyUrl(ID)).toBe(`${SHEET}/copy`);
  });
});

describe("a member's Guide (N77)", () => {
  it("holds the sections for everyone and no admin section or form", () => {
    const html = render(false, LINK);
    for (const title of ADMIN_TITLES)
      expect(headings(html)).not.toContain(title);
    expect(text(html)).not.toContain("For the admin");
    // Only the form to send a sheet (N83); never the template link form (N80).
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Send a sheet to the admin"');
    expect(html).not.toContain('id="template-url"');
    expect(html).not.toContain(TEMPLATE_LINK_COPY.label);
    for (const title of [
      "What Knit is",
      "Today",
      "Day view and Calendar",
      "All Tasks and the task drawer",
      "Statuses",
      "How a change reaches the sheet",
      "The Knit Note",
      "Spillover and the midnight close",
      "Owner and Maker",
      "Sync now",
      "Report an issue",
      "Working days and holidays",
      "Add a new tracker",
    ])
      expect(headings(html)).toContain(title);
  });

  it("offers Get the tracker template as Google's make-a-copy page in a new tab", () => {
    const html = render(false, LINK);
    expect(text(html)).toContain("Get the tracker template");
    expect(html).toContain(`href="${SHEET}/copy"`);
    expect(html).toContain('target="_blank"');
    expect(text(html)).not.toContain(TEMPLATE_LINK_COPY.askAdmin);
  });

  it("asks a member to ask the admin when no link is saved", () => {
    const html = render(false, null);
    expect(text(html)).toContain("Ask the admin for the tracker template.");
    expect(text(html)).not.toContain("Get the tracker template");
    expect(text(html)).not.toContain(TEMPLATE_LINK_COPY.noneYet);
  });

  it("uses the app's own labels, so they cannot drift (N79)", () => {
    const shown = text(render(false));
    for (const key of GROUP_ORDER) expect(shown).toContain(TODAY_TITLES[key]);
    for (const label of Object.values(STATUS_LABELS))
      expect(shown).toContain(label);
  });
});

describe("the admin's Guide (N77)", () => {
  it("holds every admin section and the template link form", () => {
    const html = render(true, LINK);
    for (const title of ADMIN_TITLES) expect(headings(html)).toContain(title);
    expect(html).toContain('name="url"');
    expect(html).toContain(`value="${SHEET}"`);
    expect(text(html)).toContain("Save link");
    expect(text(html)).toContain("Get the tracker template");
  });

  it("tells the admin where to add a link when none is saved", () => {
    const shown = text(render(true, null));
    expect(shown).toContain(
      "No template link yet. Add it under Tracker template link below.",
    );
    expect(shown).not.toContain(TEMPLATE_LINK_COPY.askAdmin);
  });

  it("names the wizard steps, Needs Attention titles and template headers as the app does", () => {
    const shown = text(render(true));
    for (const step of ["header", "owners", "details", "preview", "activate"])
      expect(shown).toContain(WIZARD_STEPS.find((s) => s.step === step)!.title);
    for (const kind of [
      "unmapped_status",
      "unknown_owner",
      "bad_date",
      "conflict",
      "missing_header",
      "member_report",
    ])
      expect(shown).toContain(ATTENTION_TITLES[kind]);
    expect(shown).toContain(KNIT_STANDARD_V2.headers.join(", "));
    expect(shown).toContain("This tab follows the Knit Standard Tracker v2.");
    expect(shown).toContain("Only rows naming the person");
    expect(shown).toContain("Every row, also to the tracker owner");
  });
});

describe("the Guide page", () => {
  const page = async () => {
    const { default: GuidePage } = await import("@/app/(app)/guide/page");
    return renderToStaticMarkup(await GuidePage());
  };

  it("renders the admin sections for the admin only", async () => {
    fx.settings = { data: { value: SHEET }, error: null };
    fx.user = { id: "u", name: "Asha", email: "a@knit.test", isAdmin: false };
    const member = text(await page());
    expect(member).toContain("Get the tracker template");
    expect(member).not.toContain("For the admin");
    fx.user = { ...(fx.user as object), isAdmin: true };
    expect(text(await page())).toContain("For the admin");
  });

  it("reads the template link only for a signed-in user", async () => {
    await expect(page()).rejects.toThrow("redirect:/login");
    expect(fx.reads).toEqual([]);
  });
});

describe("loadTemplateLink (N80)", () => {
  it("reads only the tracker_template_url key", async () => {
    fx.settings = { data: { value: SHEET }, error: null };
    expect(await loadTemplateLink()).toEqual(LINK);
    expect(fx.reads).toEqual([
      ["settings", "value", ["key", "tracker_template_url"]],
    ]);
  });

  it("shows no link when none is saved, or the saved value is not a valid link", async () => {
    expect(await loadTemplateLink()).toBeNull();
    fx.settings = { data: { value: "https://example.com/x" }, error: null };
    expect(await loadTemplateLink()).toBeNull();
    fx.settings = { data: { value: 42 }, error: null };
    expect(await loadTemplateLink()).toBeNull();
  });

  it("shows no link when settings cannot be read, logging only the error code", async () => {
    fx.settings = { data: { value: SHEET }, error: { code: "PGRST000" } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await loadTemplateLink()).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]![0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "guide.template_link_read_failed",
        code: "PGRST000",
      });
      expect(line).not.toContain(ID);
    } finally {
      log.mockRestore();
    }
  });

  it("still opens the Guide for a member when the read fails", async () => {
    fx.settings = { data: null, error: { code: "PGRST000" } };
    fx.user = { id: "u", name: "Asha", email: "a@knit.test", isAdmin: false };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { default: GuidePage } = await import("@/app/(app)/guide/page");
      const shown = text(renderToStaticMarkup(await GuidePage()));
      expect(shown).toContain("Ask the admin for the tracker template.");
      expect(shown).toContain("Add a new tracker");
    } finally {
      log.mockRestore();
    }
  });
});

describe("what the Guide says matches the app (N79, N80, N81)", () => {
  it("writes an open-ended task's label as Today shows it", () => {
    const shown = text(render(false));
    expect(shown).toContain(
      `open-ended tasks (${dueLabel(openEnded("2026-10-30"))})`,
    );
    expect(shown).toContain("(From Fri 30 Oct)");
    expect(shown).toContain(
      "On its due date (its last working day) a task moves to Due today.",
    );
  });

  it("lists the template's Status words for everyone, as the sheet spells them", () => {
    const shown = text(render(false));
    const words = [
      "yet_to_start",
      "in_progress",
      "blocked",
      "done",
      "cancelled",
    ]
      .map(
        (s) =>
          KNIT_STANDARD_V2.statusWords[
            s as keyof typeof KNIT_STANDARD_V2.statusWords
          ],
      )
      .join(", ");
    expect(words).toBe("Not started, In progress, Blocked, Done, Cancelled");
    expect(shown).toContain(`Status picked from its dropdown (${words})`);
    expect(shown).toContain(
      "Get the sheet into the Knit folder: move it there yourself if you can edit that folder (into the folder itself, not a folder inside it, and not as a shortcut), or share it with the admin and ask them to move it.",
    );
    expect(shown).toContain(
      "Then paste its link below and press Check and send.",
    );
  });

  it("says when the pill turns amber, and what Sync now allows", () => {
    const shown = text(render(false));
    expect(shown).toContain(
      "If Knit cannot write it after several tries, the pill turns amber, Not saved to sheet, and the admin sees why in Needs Attention and can retry it.",
    );
    expect(shown).not.toContain("Knit keeps trying");
    expect(shown).toContain("You can press it once every 30 seconds.");
  });

  it("colours a closed day with a Blocked task amber, and only Not Done red", () => {
    const shown = text(render(false));
    expect(shown).toContain("red: a closed day with a task marked Not Done;");
    expect(shown).toContain(
      "an earlier day not closed yet or holding a Blocked task;",
    );
  });

  it("tells the admin to share the template, keep it out of the Knit folder and never connect it", () => {
    const shown = text(render(true));
    expect(shown).toContain("Share the blank template so everyone can view it");
    expect(shown).toContain("Keep the template outside the Knit folder");
    expect(shown).toContain("Never connect it");
    expect(TEMPLATE_LINK_COPY.hint).toContain("shared so everyone can view it");
    expect(shown).toContain(TEMPLATE_LINK_COPY.hint);
  });

  it("pauses only for a renamed, deleted or doubled header, never for a moved one", () => {
    const shown = text(render(true));
    expect(shown).not.toContain("reorder");
    expect(shown).toContain("Never rename, delete or double a header.");
    expect(shown).toContain(
      "Moving a column of a connected tracker does not pause it.",
    );
    expect(shown).toContain("appears twice");
    expect(shown).toContain("starts holding formulas");
  });

  it("says Resume is pressed after a missing column is back, and when a conflict is raised", () => {
    const shown = text(render(true));
    expect(shown).toContain(
      "Column missing: the tracker is paused; put the column back, then press Resume",
    );
    expect(shown).toContain("or the sheet reopened a finished task");
    expect(shown).toContain(
      "If the name is already linked to someone else, it moves to the new person, and so do its tasks.",
    );
  });
});

describe("sending a sheet to the admin (N83, N85, N89)", () => {
  const REQUESTS: MyTrackerRequest[] = [
    {
      id: 3,
      fileName: "Brand Zeta",
      state: "open",
      dismissReason: null,
      createdAt: "2026-10-04T20:00:00Z",
    },
    {
      id: 2,
      fileName: "Brand Eta",
      state: "connected",
      dismissReason: null,
      createdAt: "2026-10-02T05:00:00Z",
    },
    {
      id: 1,
      fileName: "Brand Theta",
      state: "dismissed",
      dismissReason: "Use the Sapiens tracker",
      createdAt: "2026-10-01T05:00:00Z",
    },
  ];

  it("a member and the admin both get the form and their requests", () => {
    for (const isAdmin of [false, true]) {
      const shown = text(render(isAdmin, LINK, REQUESTS));
      for (const copy of [
        "Send a sheet to the admin",
        "Link to your sheet",
        REQUEST_COPY.linkHint,
        "Note for the admin (optional)",
        REQUEST_COPY.noteHint,
        "Check and send",
        "Your requests",
        "Brand Zeta · sent Mon 5 Oct",
        "Waiting for the admin",
        "Brand Eta · sent Fri 2 Oct",
        "Connected",
        "Not taken: Use the Sapiens tracker",
        "The admin makes every login and sets every password. To change yours, ask the admin.",
      ])
        expect(shown, copy).toContain(copy);
    }
    const member = render(false, LINK, REQUESTS);
    for (const title of ADMIN_TITLES)
      expect(headings(member)).not.toContain(title);
    expect(text(member)).not.toContain("For the admin");
  });

  it("leaves Your requests out until the person has one", () => {
    const shown = text(render(false, LINK));
    expect(shown).toContain("Send a sheet to the admin");
    expect(shown).not.toContain("Your requests");
  });

  it("tells the admin how a requested sheet reaches Needs Attention", () => {
    const shown = text(render(true));
    expect(ATTENTION_TITLES.tracker_request).toBe("New tracker requested");
    expect(shown).toContain(
      "A person can also send a sheet from Add a new tracker. Knit checks it first, then adds New tracker requested to Needs Attention, with Set up. Activating the tracker closes the item; Dismiss asks for a reason, which the person sees.",
    );
    expect(text(render(false))).not.toContain(
      "A person can also send a sheet from Add a new tracker.",
    );
  });

  it("the page reads the person's own last 10 requests, newest first", async () => {
    fx.user = { id: "u-7", name: "Asha", email: "a@knit.test", isAdmin: false };
    fx.requests = {
      data: [
        {
          id: 3,
          file_name: "Brand Zeta",
          state: "dismissed",
          dismiss_reason: "Not ours",
          created_at: "2026-10-04T06:00:00Z",
        },
      ],
      error: null,
    };
    const { default: GuidePage } = await import("@/app/(app)/guide/page");
    const shown = text(renderToStaticMarkup(await GuidePage()));
    expect(shown).toContain("Brand Zeta · sent Sun 4 Oct");
    expect(shown).toContain("Not taken: Not ours");
    expect(fx.requestReads).toEqual([
      [
        "tracker_requests",
        "id, file_name, state, dismiss_reason, created_at",
        ["requested_by", "u-7"],
        ["created_at", { ascending: false }],
        10,
      ],
    ]);
  });

  it("still opens the Guide when the requests cannot be read, logging only the code", async () => {
    fx.user = { id: "u-7", name: "Asha", email: "a@knit.test", isAdmin: false };
    fx.requests = { data: null, error: { code: "PGRST000" } };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { default: GuidePage } = await import("@/app/(app)/guide/page");
      const shown = text(renderToStaticMarkup(await GuidePage()));
      expect(shown).toContain("Send a sheet to the admin");
      expect(shown).not.toContain("Your requests");
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
        event: "guide.tracker_requests_read_failed",
        code: "PGRST000",
      });
    } finally {
      log.mockRestore();
    }
  });
});
