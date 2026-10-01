import "server-only";

import { cache } from "react";
import { z } from "zod";

import { LocalDateSchema, TaskCard, TRACKER_COLORS } from "@/lib/domain/cards";
import { calendarFromDays } from "@/lib/domain/calendar";
import { normaliseKey } from "@/lib/domain/config";
import { aliasMap } from "@/lib/domain/owners";
import { isEmptyRow, normaliseRow } from "@/lib/domain/rows";
import {
  DraftConfig,
  finalConfig,
  goLiveDefault,
  goLiveSaved,
  statusChoices,
  unmappedChoices,
} from "@/lib/domain/wizard";
import { jobDeps } from "@/lib/jobs/cron";
import {
  KNIT_ID_HEADER,
  type TabRef,
  type TabStructure,
} from "@/lib/sheets/types";
import { callRpc, getSupabase } from "@/lib/supabase/server";
import type { LocalDate } from "@/lib/time";

/**
 * Data for the admin screens (PRD 11, 12.8), read as the signed-in admin (RLS and the admin
 * functions check it), plus the sheet reads the setup wizard needs.
 */

const TrackerState = z.enum([
  "draft",
  "active",
  "paused",
  "disconnected",
  "archived",
]);

export const AdminTrackers = z.object({
  trackers: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      color: z.enum(TRACKER_COLORS),
      state: TrackerState,
      pauseReason: z.string().nullable(),
      fileId: z.string(),
      gid: z.number(),
      tabName: z.string(),
      fileName: z.string(),
      lastPullAt: z.string().nullable(),
      goLiveDate: LocalDateSchema,
      taskCount: z.number(),
      backlogCount: z.number(),
      openAttention: z.number(),
    }),
  ),
  files: z.array(
    z.object({
      fileId: z.string(),
      name: z.string(),
      state: z.enum([
        "new",
        "ignored",
        "connected",
        "not_a_sheet",
        "left_folder",
      ]),
      modifiedTime: z.string().nullable(),
      trackers: z.number(),
    }),
  ),
});
export type AdminTrackers = z.infer<typeof AdminTrackers>;

export const loadAdminTrackers = () => callRpc(AdminTrackers, "admin_trackers");

const TrackerRow = z.object({
  id: z.uuid(),
  file_id: z.string(),
  sheet_gid: z.number(),
  tab_name: z.string(),
  name: z.string(),
  color: z.enum(TRACKER_COLORS),
  state: TrackerState,
  pause_reason: z.string().nullable(),
  config: z.record(z.string(), z.unknown()),
  go_live_date: LocalDateSchema,
  last_pull_at: z.string().nullable(),
  owner_user_id: z.uuid().nullable(),
});

export interface AdminTracker {
  id: string;
  fileId: string;
  gid: number;
  tabName: string;
  name: string;
  color: (typeof TRACKER_COLORS)[number];
  state: z.infer<typeof TrackerState>;
  pauseReason: string | null;
  draft: DraftConfig;
  goLiveDate: string;
  lastPullAt: string | null;
  ownerUserId: string | null;
  ref: TabRef;
}

/** One tracker with its (possibly unfinished) config, or null. */
export const loadTracker = cache(
  async (id: string): Promise<AdminTracker | null> => {
    if (!z.uuid().safeParse(id).success) return null;
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from("trackers")
      .select(
        "id, file_id, sheet_gid, tab_name, name, color, state, pause_reason, config, go_live_date, last_pull_at, owner_user_id",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`trackers read failed: ${error.code}`);
    if (!data) return null;
    const row = TrackerRow.parse(data);
    return {
      id: row.id,
      fileId: row.file_id,
      gid: row.sheet_gid,
      tabName: row.tab_name,
      name: row.name,
      color: row.color,
      state: row.state,
      pauseReason: row.pause_reason,
      draft: DraftConfig.parse(row.config),
      goLiveDate: row.go_live_date,
      lastPullAt: row.last_pull_at,
      ownerUserId: row.owner_user_id,
      ref: { fileId: row.file_id, sheetId: row.sheet_gid },
    };
  },
);

/** The sheet source and the jobs' store (service role), for the wizard's reads. */
export const loadSheetDeps = cache(async () => {
  const { store, source } = await jobDeps();
  return { store, source };
});

/**
 * 11 steps 7 and 9 (N42): the go-live step 7 shows and activation would use. A saved date, or a
 * tracker's once it is not a draft, as it is (N19 b). Otherwise the next working day after
 * today, or null when the calendar does not cover it; only then are today and the calendar
 * read.
 */
export async function currentGoLive(
  tracker: AdminTracker,
): Promise<LocalDate | null> {
  if (goLiveSaved(tracker)) return tracker.goLiveDate;
  const { store } = await loadSheetDeps();
  const [today, context] = await Promise.all([
    store.today(),
    store.loadContext(),
  ]);
  return goLiveDefault(tracker, today, calendarFromDays(context.calendar));
}

/** 11 step 3: the first ten rows of a tab, as shown. */
export const loadTopRows = cache(async (ref: TabRef) => {
  const { source } = await loadSheetDeps();
  return source.readTopRows(ref, 10);
});

/** The wizard's view of a header row: blank headers and Knit's own columns left out. */
function wizardStructure(structure: TabStructure): TabStructure {
  return {
    ...structure,
    headers: structure.headers.filter(
      (h) =>
        h.header.trim() !== "" &&
        h.normalised !== KNIT_ID_HEADER.toLowerCase() &&
        h.normalised !== "knit note",
    ),
  };
}

/**
 * 11 step 3 (N68): headers, formula columns and dropdowns of a header row, without the data
 * rows. Enough to decide whether a standard template matches row 1.
 */
export const loadStructure = cache(async (ref: TabRef, headerRow: number) => {
  const { source } = await loadSheetDeps();
  return wizardStructure(await source.readStructure(ref, headerRow));
});

/** 11 step 4: headers, formula columns and dropdowns, and the data rows under them. */
export const loadTabData = cache(async (ref: TabRef, headerRow: number) => {
  const { source } = await loadSheetDeps();
  const [structure, rows] = await Promise.all([
    source.readStructure(ref, headerRow),
    source.readRows(ref, headerRow),
  ]);
  return { structure: wizardStructure(structure), rows };
});

/**
 * 11 step 5: the words of a status column as the tab holds them now (its dropdown and every
 * word in use) that the draft's status map does not cover yet. Activation is blocked while
 * any is left, so a column changed after step 5, or a word typed into the sheet since, is
 * caught before the first pull.
 */
export async function unmappedStatusWords(
  tracker: AdminTracker,
): Promise<string[]> {
  const { headerRow, columns, statusMap } = tracker.draft;
  if (headerRow === undefined || !columns?.statusRead) return [];
  const { structure, rows } = await loadTabData(tracker.ref, headerRow);
  const choices = statusChoices(
    rows,
    columns.statusRead,
    structure.validations[normaliseKey(columns.statusRead)]?.options ?? null,
  );
  return unmappedChoices(choices, statusMap).map((choice) => choice.word);
}

/** 11 steps 6 and 8: the rows as the pull would read them with the draft's config. */
export async function loadNormalisedRows(tracker: AdminTracker) {
  const config = finalConfig(tracker.draft);
  if (!config.success || tracker.draft.headerRow === undefined) return null;
  const { store } = await loadSheetDeps();
  const [{ rows }, context, today] = await Promise.all([
    loadTabData(tracker.ref, tracker.draft.headerRow),
    store.loadContext(),
    store.today(),
  ]);
  const calendar = calendarFromDays(context.calendar);
  const aliases = aliasMap(context.aliases);
  return {
    today,
    /** 11 step 8: the go-live activation would use (N42); null when step 7 must choose one. */
    goLive: goLiveDefault(tracker, today, calendar),
    config: config.data,
    rows: rows
      .filter((row) => !isEmptyRow(row, config.data))
      .map((row) =>
        normaliseRow(row, {
          config: config.data,
          calendar,
          aliases,
          trackerOwnerId: tracker.ownerUserId,
          today,
          knitIdHeader: KNIT_ID_HEADER,
        }),
      ),
  };
}

export const SyncHealth = z.object({
  today: LocalDateSchema,
  runs: z.array(
    z.object({
      id: z.number(),
      job: z.string(),
      tracker: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      ok: z.boolean().nullable(),
      stats: z.record(z.string(), z.unknown()).nullable(),
      error: z.string().nullable(),
    }),
  ),
  outbox: z.record(z.string(), z.number()),
  closures: z.array(
    z.object({
      day: LocalDateSchema,
      state: z.string(),
      startedAt: z.string(),
      closedAt: z.string().nullable(),
      stats: z.record(z.string(), z.unknown()).nullable(),
      error: z.string().nullable(),
    }),
  ),
  calendarEnd: LocalDateSchema.nullable(),
  openAttention: z.number(),
});
export const loadSyncHealth = () => callRpc(SyncHealth, "admin_sync_health");

export const AttentionItem = z.object({
  id: z.number(),
  kind: z.string(),
  detail: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  tracker: z
    .object({
      id: z.uuid(),
      name: z.string(),
      color: z.enum(TRACKER_COLORS),
      fileId: z.string(),
      gid: z.number(),
      state: TrackerState,
    })
    .nullable(),
  task: z
    .object({ id: z.uuid(), title: z.string(), rowHint: z.number().nullable() })
    .nullable(),
  reporter: z.string().nullable(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;
export const loadAttention = () =>
  callRpc(z.array(AttentionItem), "admin_attention");

export const loadBacklog = (trackerId: string) =>
  callRpc(z.array(TaskCard), "admin_backlog", { p_tracker_id: trackerId });

const UserRow = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["admin", "member"]),
  is_active: z.boolean(),
});
const AliasRow = z.object({
  alias_norm: z.string(),
  display: z.string(),
  user_id: z.uuid().nullable(),
});

/** 12.8 People: every user and every alias (admin reads all, 9.2). */
export async function loadPeople() {
  const supabase = await getSupabase();
  const [users, aliases] = await Promise.all([
    supabase
      .from("app_users")
      .select("id, name, email, role, is_active")
      .order("name"),
    supabase
      .from("people_aliases")
      .select("alias_norm, display, user_id")
      .order("alias_norm"),
  ]);
  if (users.error || aliases.error) throw new Error("people read failed");
  return {
    users: z.array(UserRow).parse(users.data),
    aliases: z.array(AliasRow).parse(aliases.data),
  };
}

const HolidayRow = z.object({ day: LocalDateSchema, name: z.string() });

/** 12.8 Holidays, and how far the working-day calendar reaches. */
export async function loadHolidays() {
  const supabase = await getSupabase();
  const [holidays, end] = await Promise.all([
    supabase.from("holidays").select("day, name").order("day"),
    supabase
      .from("calendar_days")
      .select("day")
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (holidays.error || end.error) throw new Error("holidays read failed");
  return {
    holidays: z.array(HolidayRow).parse(holidays.data),
    calendarEnd: end.data
      ? LocalDateSchema.parse((end.data as { day: string }).day)
      : null,
  };
}
