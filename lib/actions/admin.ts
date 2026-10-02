"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import {
  loadSheetDeps,
  loadTabData,
  loadTracker,
  unmappedStatusWords,
  type AdminTracker,
} from "@/lib/admin/data";
import { calendarFromDays } from "@/lib/domain/calendar";
import { TRACKER_COLORS } from "@/lib/domain/cards";
import {
  KnitUserStatus,
  normaliseKey,
  TrackerConfig,
  USER_STATUSES,
  type UserStatus,
} from "@/lib/domain/config";
import {
  matchStandardTemplate,
  STANDARD_NOT_DRAFT,
  STANDARD_TEMPLATE_IDS,
  STANDARD_TEMPLATES,
  standardSetupDraft,
  standardTabChanged,
} from "@/lib/domain/standard-template";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";
import {
  completedOnPatternProblem,
  DraftConfig,
  draftProblems,
  finalConfig,
  GO_LIVE_NEEDS_A_DATE,
  goLiveDefault,
  nextColour,
  statusChoices,
  statusField,
  unmappedChoices,
  writeBackField,
  writeBackOptions,
  writeBackValue,
  writeTargetProblem,
  type WizardStep,
} from "@/lib/domain/wizard";
import { messageFor, SIGNED_OUT_ERROR } from "@/lib/errors";
import { withJobLease } from "@/lib/jobs/cron";
import { SheetError, type TabStructure } from "@/lib/sheets/types";
import {
  getCurrentUser,
  getSupabase,
  type CurrentUser,
} from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { discover } from "@/lib/sync/discover";
import { errorSummary, logEvent } from "@/lib/sync/log";
import { pullAll, pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";
import { recreateKnitIds } from "@/lib/sync/recreate-ids";
import { checkStructure, type StructureProblem } from "@/lib/sync/structure";
import { isLocalDate } from "@/lib/time";

// PRD 11, 12.8, 13: the admin's actions. Each checks the caller is the active admin first,
// then validates every input with zod (9.3), the arguments bound in the page as well as the
// form fields; rules (tracker states, backlog, attention, retries) live in the database
// functions they call, and tracker configs are validated with zod before they are saved (8.2).

export interface FormState {
  error: string | null;
  notice?: string | null;
  /** 12.8, N19(g): the number of open tasks the admin is asked to confirm. */
  confirm?: number;
}

const NOT_ADMIN: FormState = { error: "Only the admin can do this." };
const INVALID: FormState = {
  error: "This is no longer valid. Reload the page and try again.",
};

/**
 * The caller must be the active admin. A caller whose session has ended is told to sign in
 * again, as the task actions do (proxy.ts leaves an action call to the action's own check),
 * and only a signed-in user who is not the admin is told this is for the admin.
 */
async function adminGate(): Promise<
  { user: CurrentUser; refusal: null } | { user: null; refusal: FormState }
> {
  const user = await getCurrentUser();
  if (!user) return { user: null, refusal: { error: SIGNED_OUT_ERROR } };
  if (!user.isAdmin) return { user: null, refusal: NOT_ADMIN };
  return { user, refusal: null };
}
const adminRefusal = async () => (await adminGate()).refusal;

// 9.3: the arguments pages bind to these actions arrive as the browser sends them.
const TrackerId = z.uuid();
const UserId = z.uuid();
const ItemId = z.number().int().positive();
const FileId = z.string().trim().min(1).max(200);
const SheetId = z.number().int().nonnegative();
const OwnerName = z.string().trim().min(1).max(200);
const StatusWord = z.string().max(200);

/**
 * A forced pull of some or all active trackers after the response (7.3), under the lease.
 * When another pull holds the lease this one is not run, but nothing is lost: a change to a
 * tracker's config, the people aliases or the calendar is recorded in the database as a pull
 * the tracker is owed (trackers.pull_requested), and the next pull takes it up even when the
 * sheet has not changed.
 */
function pullLater(trackerIds?: string[]) {
  after(async () => {
    try {
      const run = await withJobLease(
        "pull",
        60,
        ({ store, source, deadline }) =>
          pullAll({ store, source }, { force: true, trackerIds, deadline }),
      );
      if (run.skipped)
        logEvent("admin.pull_deferred", {
          trackers: trackerIds?.length ?? "all",
        });
    } catch (error) {
      logEvent("admin.pull_failed", { error: errorSummary(error) });
    }
  });
}

function pushLater() {
  after(async () => {
    try {
      await withJobLease("push", 60, ({ store, source, deadline }) =>
        pushDue({ store, source }, { deadline }),
      );
    } catch (error) {
      logEvent("admin.push_failed", { error: errorSummary(error) });
    }
  });
}

async function setTrackerState(
  trackerId: string,
  state: "active" | "paused" | "archived",
  reason?: string,
) {
  const { error } = await createServiceClient().rpc("set_tracker_state", {
    p_tracker_id: trackerId,
    p_state: state,
    p_reason: reason ?? null,
  });
  if (error) throw new Error(error.message);
}

const text = (form: FormData, key: string) =>
  String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || null;

/** Two header choices name the same column (nothing and nothing included). */
const sameHeader = (
  a: string | null | undefined,
  b: string | null | undefined,
) => normaliseKey(a ?? "") === normaliseKey(b ?? "");

// ---------------------------------------------------------------------------------------
// Tracker setup wizard (11)

const NEXT_STEP: Record<WizardStep, WizardStep | "done"> = {
  tab: "header",
  header: "columns",
  columns: "statuses",
  statuses: "owners",
  owners: "details",
  details: "preview",
  preview: "activate",
  activate: "done",
};

/**
 * Saves part of a tracker's config. A draft may stay incomplete; a live tracker's config must
 * stay complete, and saving it runs the structure check and a forced pull (11: editing). No
 * config may write to a content column (invariant 5). A live tracker's status columns change
 * only together with their status mapping (saveStatuses), so no pull ever reads a status column
 * whose words the map does not cover (11 step 5, 6.8).
 */
async function saveDraft(
  tracker: AdminTracker,
  patch: Partial<DraftConfig>,
  options: { newStatusColumns?: boolean } = {},
): Promise<string | null> {
  const draft = DraftConfig.parse({ ...tracker.draft, ...patch });
  const conflict = writeTargetProblem(draft.columns ?? {}, draft.titleTemplate);
  if (conflict) return conflict;
  if (tracker.state !== "draft") {
    const complete = finalConfig(draft);
    if (!complete.success)
      return "This change would leave the tracker incomplete.";
    const saved = tracker.draft.columns ?? {};
    const next = draft.columns ?? {};
    if (
      !options.newStatusColumns &&
      (!sameHeader(saved.statusRead, next.statusRead) ||
        !sameHeader(saved.statusWrite, next.statusWrite))
    )
      return "Map the words of the new status column first.";
  }
  const { error } = await createServiceClient()
    .from("trackers")
    .update({ config: draft })
    .eq("id", tracker.id);
  if (error) return "The change could not be saved. Try again.";
  if (tracker.state === "active") pullLater([tracker.id]);
  return null;
}

function afterSave(tracker: AdminTracker, step: WizardStep): never {
  if (tracker.state !== "draft")
    redirect(`/admin/trackers/${tracker.id}?saved=1`);
  const next = NEXT_STEP[step];
  redirect(
    next === "done"
      ? `/admin/trackers/${tracker.id}`
      : `/admin/trackers/${tracker.id}/setup/${next}`,
  );
}

/** 11 step 2: a draft tracker for one tab of a new sheet. */
export async function startSetup(
  fileIdInput: string,
  sheetIdInput: number,
): Promise<FormState> {
  const { user, refusal } = await adminGate();
  if (!user) return refusal;
  const parsed = z
    .object({ fileId: FileId, sheetId: SheetId })
    .safeParse({ fileId: fileIdInput, sheetId: sheetIdInput });
  if (!parsed.success) return INVALID;
  const { fileId, sheetId } = parsed.data;
  const service = createServiceClient();
  const { data: existing } = await service
    .from("trackers")
    .select("id, state")
    .eq("file_id", fileId)
    .eq("sheet_gid", sheetId)
    .maybeSingle();
  if (existing) {
    const found = z.object({ id: z.uuid(), state: z.string() }).parse(existing);
    if (found.state === "archived")
      return { error: "This tab was connected before and is archived." };
    redirect(
      found.state === "draft"
        ? `/admin/trackers/${found.id}/setup/header`
        : `/admin/trackers/${found.id}`,
    );
  }
  const { store, source } = await loadSheetDeps();
  const [file, tabs, used, today] = await Promise.all([
    service
      .from("drive_files")
      .select("name")
      .eq("file_id", fileId)
      .maybeSingle(),
    source.listTabs(fileId),
    service.from("trackers").select("color").neq("state", "archived"),
    store.today(),
  ]);
  const tab = tabs.find((t) => t.sheetId === sheetId);
  const fileName = z.object({ name: z.string() }).safeParse(file.data);
  if (!tab || !fileName.success)
    return { error: "That sheet or tab is no longer in the Knit folder." };
  const colours = z
    .array(z.object({ color: z.string() }))
    .parse(used.data ?? [])
    .map((row) => row.color);
  const { data, error } = await service
    .from("trackers")
    .insert({
      file_id: fileId,
      sheet_gid: sheetId,
      tab_name: tab.title,
      name: `${fileName.data.name} · ${tab.title}`.slice(0, 80),
      color: nextColour(colours),
      state: "draft",
      config: {},
      go_live_date: today,
      owner_user_id: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return { error: "The setup could not start. Try again." };
  await service
    .from("drive_files")
    .update({ state: "connected" })
    .eq("file_id", fileId);
  redirect(
    `/admin/trackers/${String((data as { id: string }).id)}/setup/header`,
  );
}

/** 11 step 3. */
export async function saveHeaderRow(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const tracker = await loadTracker(trackerId);
  if (!tracker) return { error: "This tracker no longer exists." };
  const headerRow = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .safeParse(form.get("headerRow"));
  if (!headerRow.success) return { error: "Choose the header row." };
  const error = await saveDraft(tracker, { headerRow: headerRow.data });
  if (error) return { error };
  afterSave(tracker, "header");
}

/**
 * 11.1, N68, N69: Use the standard setup, on the header row step of a draft. Row 1 of the tab
 * is read again and matched (lib/domain/standard-template.ts); the draft is filled from the
 * template and saved as the steps would save it. Then Owners and policies opens, or Map
 * statuses when a word or a write-back value is left; nothing from the sheet goes in the URL.
 */
export async function applyStandardSetup(
  trackerId: string,
  templateId: string,
  // ActionForm passes its state and the form; this action reads neither.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _previous: FormState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({
      trackerId: TrackerId,
      templateId: z.enum(STANDARD_TEMPLATE_IDS as [string, ...string[]]),
    })
    .safeParse({ trackerId, templateId });
  if (!parsed.success) return INVALID;
  const tracker = await loadTracker(parsed.data.trackerId);
  if (!tracker) return { error: "This tracker no longer exists." };
  const template = STANDARD_TEMPLATES.find(
    (t) => t.id === parsed.data.templateId,
  )!;
  if (tracker.state !== "draft") return { error: STANDARD_NOT_DRAFT };
  const { structure, rows } = await loadTabData(tracker.ref, 1);
  const match = matchStandardTemplate(structure);
  if (!match || match.template.id !== template.id)
    return { error: standardTabChanged(template) };
  if (match.problem !== null) return { error: match.problem };
  const status = match.headers[normaliseKey("Status")] ?? "Status";
  const dropdown = structure.validations[normaliseKey(status)]?.options ?? null;
  const { patch, next } = standardSetupDraft(
    match,
    structure,
    statusChoices(rows, status, dropdown),
    writeBackOptions(rows, status, dropdown),
  );
  const error = await saveDraft(tracker, patch);
  if (error) return { error };
  redirect(`/admin/trackers/${tracker.id}/setup/${next}?standard=applied`);
}

/**
 * 11 step 4. Write targets may not hold formulas (N6) or content (invariant 5), and a
 * completed-on text pattern must read back as the date it wrote (6.8). When the status
 * columns change, their words are mapped again (11 step 5): a draft's status map is cleared,
 * and a live tracker keeps its current status columns until the statuses step maps the new
 * ones.
 */
export async function saveColumns(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const tracker = await loadTracker(trackerId);
  if (!tracker?.draft.headerRow)
    return { error: "Choose the header row first." };
  const [{ structure }, today] = await Promise.all([
    loadTabData(tracker.ref, tracker.draft.headerRow),
    (await loadSheetDeps()).store.today(),
  ]);
  const headers = new Map(
    structure.headers.map((h) => [h.normalised, h.header]),
  );
  const pick = (key: string) => {
    const value = optional(form, key);
    return value !== null && headers.has(normaliseKey(value)) ? value : null;
  };
  const formula = new Set(structure.formulaColumns);
  const date = pick("date");
  const title = pick("title");
  const statusRead = pick("statusRead");
  if (!date || !title || !statusRead)
    return { error: "Choose the date, title and status columns." };
  const statusWrite = pick("statusWrite");
  const completedOn = pick("completedOn");
  for (const target of [statusWrite, completedOn]) {
    if (target && formula.has(normaliseKey(target)))
      return {
        error: `"${target}" holds formulas, so Knit cannot write to it. Choose another column.`,
      };
  }
  const criticalHeader = pick("critical");
  const truthy = text(form, "criticalTruthy")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (criticalHeader && truthy.length === 0)
    return {
      error: "Give the value that marks a row as critical, for example Yes.",
    };
  const details = form
    .getAll("details")
    .map(String)
    .filter((h) => headers.has(normaliseKey(h)));
  if (details.length > 8) return { error: "Choose at most 8 detail columns." };
  const format = text(form, "completedOnFormat");
  const pattern = text(form, "completedOnPattern") || "EEE d MMM";
  if (completedOn && format !== "date") {
    const problem = completedOnPatternProblem(pattern, today);
    if (problem) return { error: problem };
  }
  const titleTemplate = text(form, "titleTemplate") || `{${title}}`;
  const columns = {
    date,
    // N64: optional; null for "No end date column".
    endDate: pick("endDate"),
    title,
    statusRead,
    statusWrite,
    completedOn,
    owner: pick("owner"),
    // N73: optional; null for "No checking owner column".
    checker: pick("checker"),
    sourceRef: pick("sourceRef"),
    critical: criticalHeader ? { header: criticalHeader, truthy } : null,
  };
  const conflict = writeTargetProblem(columns, titleTemplate);
  if (conflict) return { error: conflict };

  const saved = tracker.draft.columns ?? {};
  const readChanged = !sameHeader(saved.statusRead, statusRead);
  const writeChanged = !sameHeader(saved.statusWrite, statusWrite);
  const live = tracker.state !== "draft";
  const pending = live && (readChanged || writeChanged);
  const error = await saveDraft(tracker, {
    columns: pending
      ? {
          ...columns,
          statusRead: saved.statusRead,
          statusWrite: saved.statusWrite ?? null,
        }
      : columns,
    readOnlyColumns: structure.headers
      .filter((h) => formula.has(h.normalised))
      .map((h) => h.header),
    titleTemplate,
    subtitleTemplate: optional(form, "subtitleTemplate"),
    detailColumns: details,
    completedOnFormat: !completedOn
      ? null
      : format === "date"
        ? { type: "date" }
        : { type: "text", pattern },
    // A draft whose status columns changed maps its words and write-backs again.
    ...(!live && readChanged
      ? { statusMap: undefined, cancelReasons: undefined }
      : {}),
    ...(!live && writeChanged ? { writeBack: undefined } : {}),
  });
  if (error) return { error };
  if (pending)
    redirect(
      `/admin/trackers/${tracker.id}/setup/statuses?${new URLSearchParams({
        statusRead,
        statusWrite: statusWrite ?? "",
      }).toString()}`,
    );
  afterSave(tracker, "columns");
}

/**
 * The new status columns a live tracker's statuses step maps (saveColumns sent them along),
 * checked against the tab again: null when none were sent.
 */
function pendingStatusColumns(
  form: FormData,
  structure: TabStructure,
): { statusRead: string; statusWrite: string | null } | null | "invalid" {
  if (!form.has("pendingStatusRead")) return null;
  const header = (value: string) =>
    structure.headers.find((h) => h.normalised === normaliseKey(value))
      ?.header ?? null;
  const statusRead = header(text(form, "pendingStatusRead"));
  const writeText = text(form, "pendingStatusWrite");
  const statusWrite = writeText === "" ? null : header(writeText);
  if (!statusRead || (writeText !== "" && !statusWrite)) return "invalid";
  if (
    statusWrite &&
    structure.formulaColumns.includes(normaliseKey(statusWrite))
  )
    return "invalid";
  return { statusRead, statusWrite };
}

/**
 * 11 step 5: every word mapped, and a write-back value for every Knit status, chosen from the
 * words of the status write column (6.8), or leave the cell unchanged (N8), or clear it.
 */
export async function saveStatuses(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const tracker = await loadTracker(trackerId);
  const saved = tracker?.draft.columns;
  if (!tracker?.draft.headerRow || !saved?.statusRead)
    return { error: "Map the columns first." };
  const { structure, rows } = await loadTabData(
    tracker.ref,
    tracker.draft.headerRow,
  );
  const pending =
    tracker.state === "draft" ? null : pendingStatusColumns(form, structure);
  if (pending === "invalid")
    return {
      error:
        "Those status columns are not in the tab any more. Map the columns again.",
    };
  const statusRead = pending?.statusRead ?? saved.statusRead;
  const statusWrite = pending
    ? pending.statusWrite
    : (saved.statusWrite ?? null);
  const dropdown = (header: string) =>
    structure.validations[normaliseKey(header)]?.options ?? null;
  // N69: a blank mapped before (the standard setup maps one) stays listed, so it is kept.
  const choices = statusChoices(rows, statusRead, dropdown(statusRead), {
    mappedBlank: !pending && tracker.draft.statusMap?.[""] !== undefined,
  });
  const statusMap: Record<string, UserStatus> = {};
  const cancelReasons: Record<string, string> = {};
  for (const choice of choices) {
    const value = KnitUserStatus.safeParse(form.get(statusField(choice.key)));
    if (value.success) statusMap[choice.key] = value.data;
    const reason = text(form, `cancelReason:${choice.key}`);
    if (value.success && value.data === "cancelled" && reason)
      cancelReasons[choice.key] = reason.slice(0, REASON_MAX_LENGTH);
  }
  if (unmappedChoices(choices, statusMap).length > 0)
    return { error: "Choose a Knit status for every word." };
  const words = writeBackOptions(
    rows,
    statusWrite,
    statusWrite ? dropdown(statusWrite) : null,
  );
  const writeBack = {} as Record<UserStatus, string | null>;
  for (const status of USER_STATUSES) {
    const posted = String(form.get(writeBackField(status)) ?? "");
    if (posted === "")
      return { error: "Choose a write-back value for every Knit status." };
    const value = writeBackValue(posted, words, statusWrite !== null);
    if (!value.ok)
      return {
        error: statusWrite
          ? `Choose a word that "${statusWrite}" accepts, or leave the cell unchanged.`
          : "No status write column is mapped: choose Leave unchanged.",
      };
    writeBack[status] = value.value;
  }
  const error = await saveDraft(
    tracker,
    {
      statusMap,
      cancelReasons,
      writeBack,
      ...(pending ? { columns: { ...saved, statusRead, statusWrite } } : {}),
    },
    { newStatusColumns: pending !== null },
  );
  if (error) return { error };
  // 11.1: step 5 opened by the standard setup hands its notice on to step 6. A fixed flag,
  // never sheet content, and only on a draft (afterSave sends a live tracker elsewhere).
  if (tracker.state === "draft" && form.get("standard") === "applied")
    redirect(`/admin/trackers/${tracker.id}/setup/owners?standard=applied`);
  afterSave(tracker, "statuses");
}

/** 11 step 6. */
export async function saveOwners(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const tracker = await loadTracker(trackerId);
  if (!tracker) return { error: "This tracker no longer exists." };
  const parsed = z
    .object({
      ownerFilter: z.enum(["mine", "all"]),
      offDayPolicy: z.enum([
        "previous_working_day",
        "next_working_day",
        "keep",
      ]),
    })
    .safeParse({
      ownerFilter: form.get("ownerFilter"),
      offDayPolicy: form.get("offDayPolicy"),
    });
  if (!parsed.success)
    return { error: "Choose the owner filter and the off-day policy." };
  const separators = text(form, "ownerSeparators").split(/\s+/).filter(Boolean);
  const error = await saveDraft(tracker, {
    ...parsed.data,
    ownerSeparators: separators.length > 0 ? separators : [","],
  });
  if (error) return { error };
  afterSave(tracker, "owners");
}

/**
 * 11 step 7. The go-live date can change only before activation (N19 b). Once saved here it is
 * the admin's choice; until then it defaults to the next working day (N42; see activateTracker).
 */
export async function saveDetails(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const tracker = await loadTracker(trackerId);
  if (!tracker) return { error: "This tracker no longer exists." };
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      color: z.enum(TRACKER_COLORS),
      goLive: z.string().refine(isLocalDate),
    })
    .safeParse({
      name: form.get("name"),
      color: form.get("color"),
      goLive: form.get("goLive") ?? tracker.goLiveDate,
    });
  if (!parsed.success)
    return { error: "Give a name, a colour and a go-live date." };
  const { error } = await createServiceClient()
    .from("trackers")
    .update({
      name: parsed.data.name,
      color: parsed.data.color,
      ...(tracker.state === "draft"
        ? {
            go_live_date: parsed.data.goLive,
            config: DraftConfig.parse({
              ...tracker.draft,
              goLiveChosen: true,
            }),
          }
        : {}),
    })
    .eq("id", tracker.id);
  if (error) return { error: "The change could not be saved. Try again." };
  afterSave(tracker, "details");
}

/**
 * 11 step 9: adds the Knit ID and Knit Note columns, activates the tracker and runs its first
 * pull (which writes the IDs). Then the backlog review (step 10) when old rows are open.
 * Activation is blocked while any word of the status column, as the tab holds it now, is
 * unmapped (11 step 5). Go-live is the next working day unless the admin saved a date at
 * step 7 (N42); with no saved date and no calendar day to default to, nothing is written.
 */
export async function activateTracker(trackerId: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  const tracker = await loadTracker(trackerId);
  if (!tracker || tracker.state !== "draft")
    return { error: "Only a tracker being set up can be activated." };
  const service = createServiceClient();
  try {
    const problems = draftProblems(tracker.draft, {
      unmappedWords: await unmappedStatusWords(tracker),
    });
    const config = finalConfig(tracker.draft);
    if (problems.length > 0 || !config.success)
      return { error: problems[0]?.problem ?? "The setup is not complete." };
    const { store, source } = await loadSheetDeps();
    const [today, context] = await Promise.all([
      store.today(),
      store.loadContext(),
    ]);
    const goLive = goLiveDefault(
      tracker,
      today,
      calendarFromDays(context.calendar),
    );
    if (goLive === null) return { error: GO_LIVE_NEEDS_A_DATE };
    const { error } = await service
      .from("trackers")
      .update({ config: config.data, go_live_date: goLive })
      .eq("id", tracker.id);
    if (error) throw new Error(error.message);
    await source.ensureKnitColumns(tracker.ref, config.data.headerRow);
    await setTrackerState(tracker.id, "active");
    const run = await withJobLease("pull", 60, async () => {
      // Read before the tracker, as pullAll does, so this first pull serves the requests the
      // activation itself recorded.
      const requests = await store.pullRequests([tracker.id]);
      const [synced] = await store.trackers({ ids: [tracker.id] });
      return synced
        ? pullTracker({ store, source }, synced, {
            force: true,
            request: requests[tracker.id],
          })
        : null;
    });
    if (!run.skipped && run.result?.outcome === "paused")
      return {
        error: "The tracker was paused by its first pull. See Needs Attention.",
      };
  } catch (error) {
    logEvent("admin.activate_failed", {
      tracker: tracker.id,
      error: errorSummary(error),
    });
    return { error: "Activation failed. Check Sync health and try again." };
  }
  const { count } = await service
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("tracker_id", tracker.id)
    .eq("history_only", true)
    .not("status", "in", "(done,cancelled)");
  redirect(
    (count ?? 0) > 0
      ? `/admin/trackers/${tracker.id}/backlog`
      : `/admin/trackers/${tracker.id}`,
  );
}

// ---------------------------------------------------------------------------------------
// Tracker actions (12.8)

export async function pauseTracker(trackerId: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  try {
    await setTrackerState(trackerId, "paused", "Paused by the admin");
  } catch (error) {
    // A refused change (the tracker was archived meanwhile) is said in plain language.
    logEvent("admin.pause_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return {
      error: "The tracker could not be paused. Reload the page and try again.",
    };
  }
  refresh();
  return { error: null };
}

const LEFT_FOLDER =
  "The sheet is not in the Knit folder. Move it back, then Resume.";

/** Why a tracker whose tab does not match its registry cannot resume yet (10.2 step 2, 14). */
function resumeRefusal(problem: StructureProblem): string {
  return problem.kind === "missing_knit_id_column"
    ? "Knit cannot resume yet: the Knit ID column is missing. Restore it in the sheet, or recreate it on this tracker's page."
    : `Knit cannot resume yet: ${problem.reason}. Fix the sheet or Edit mapping, then Resume.`;
}

/**
 * The tracker's sheet or tab is gone (deleted, or no longer shared with Knit): not a passing
 * failure, so the admin is told which, as the structure job tells them (14).
 */
const sheetMissing = (error: unknown) =>
  error instanceof SheetError &&
  (error.code === "tab_not_found" || error.code === "file_not_found");

/** D14: the tracker's sheet is in the Knit folder, as discover just listed it. */
async function inKnitFolder(fileId: string): Promise<boolean> {
  const { data: file } = await createServiceClient()
    .from("drive_files")
    .select("state")
    .eq("file_id", fileId)
    .maybeSingle();
  return (
    z.object({ state: z.string() }).safeParse(file).data?.state === "connected"
  );
}

/**
 * 10.1, 12.8, 14: Resume. Only when the sheet is back in the Knit folder (D14) and the tab
 * matches the registry again (invariant 7); only then are the write-backs held while it was
 * paused released, so none of them is written to a tab that is still broken.
 */
export async function resumeTracker(trackerId: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  const service = createServiceClient();
  try {
    const { store, source } = await loadSheetDeps();
    // The folder as it is now, not as the last pull saw it.
    await discover({ store, source });
    const [tracker] = await store.trackers({
      states: ["paused"],
      ids: [trackerId],
    });
    if (!tracker) return { error: "Only a paused tracker can be resumed." };
    if (!(await inKnitFolder(tracker.fileId))) return { error: LEFT_FOLDER };
    const problem = checkStructure(
      await source.readStructure(
        { fileId: tracker.fileId, sheetId: tracker.sheetGid },
        tracker.config.headerRow,
      ),
      tracker.config,
    );
    if (problem) return { error: resumeRefusal(problem) };
    const { error } = await service.rpc("set_tracker_state", {
      p_tracker_id: trackerId,
      p_state: "active",
      p_reason: null,
    });
    if (error)
      return {
        error: error.message.includes("file_outside_folder")
          ? LEFT_FOLDER
          : "The tracker could not be resumed. Try again.",
      };
  } catch (error) {
    if (sheetMissing(error))
      return {
        error:
          "Knit cannot resume yet: the sheet or tab cannot be found. Restore the sheet or its tab, then Resume.",
      };
    logEvent("admin.resume_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return {
      error: "Knit could not check the sheet. Try again in a minute.",
    };
  }
  pullLater([trackerId]);
  pushLater();
  refresh();
  return { error: null };
}

export async function archiveTracker(trackerId: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  try {
    await setTrackerState(trackerId, "archived");
  } catch (error) {
    logEvent("admin.archive_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return {
      error:
        "The tracker could not be archived. Reload the page and try again.",
    };
  }
  redirect("/admin/trackers");
}

/** 12.8 Sync now for one tracker: a forced pull, now. It says so when it could not run. */
export async function syncTracker(trackerId: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  try {
    const run = await withJobLease(
      "pull",
      60,
      async ({ store, source, deadline }) => {
        await discover({ store, source });
        return pullAll(
          { store, source },
          { force: true, trackerIds: [trackerId], deadline },
        );
      },
    );
    refresh();
    if (run.skipped)
      return { error: "A pull is already running. Try again in a minute." };
    const outcome = run.result[0];
    if (outcome?.outcome === "paused")
      return {
        error: `The tracker was paused: ${outcome.reason}. See Needs Attention.`,
      };
    if (outcome?.outcome !== "pulled" && outcome?.outcome !== "skipped")
      return { error: "The pull did not finish. Sync health shows why." };
    return { error: null, notice: "Up to date." };
  } catch (error) {
    logEvent("admin.sync_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return { error: "Sync failed. Knit tries again within 10 minutes." };
  }
}

/** 11 step 1: Ignore a new sheet, or list it again. */
export async function setFileIgnored(
  fileId: string,
  ignored: boolean,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({ fileId: FileId, ignored: z.boolean() })
    .safeParse({ fileId, ignored });
  if (!parsed.success) return INVALID;
  const supabase = await getSupabase();
  await supabase.rpc("admin_set_file_state", {
    p_file_id: parsed.data.fileId,
    p_state: parsed.data.ignored ? "ignored" : "new",
  });
  refresh();
  return { error: null };
}

/** Why the Knit ID column cannot be recreated yet: the tab has another problem to fix first. */
const recreateRefusal = (problem: StructureProblem) =>
  `Knit cannot recreate the Knit ID column yet: ${problem.reason}. Fix the sheet or Edit mapping, then try again.`;

/**
 * 14, N43, N19(e): recreate a deleted Knit ID column after the preview, then resume. It is held
 * to what Resume is held to, before anything is written: the folder is listed first and a sheet
 * outside it is refused (D14), and the tab must have no problem but the missing Knit ID column.
 * A doubled Knit ID column, or one holding formulas (N39), is fixed in the sheet and resumed,
 * never written over (invariant 2). Once the columns are added the tab is checked again, so the
 * tracker resumes only when it passes the structure check (invariant 7).
 */
export async function recreateKnitIdColumn(
  trackerId: string,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!TrackerId.safeParse(trackerId).success) return INVALID;
  try {
    const { store, source } = await loadSheetDeps();
    // The folder as it is now, not as the last pull saw it.
    await discover({ store, source });
    const [tracker] = await store.trackers({
      states: ["paused"],
      ids: [trackerId],
    });
    if (!tracker)
      return {
        error: "Only a paused tracker's Knit ID column can be recreated.",
      };
    if (!(await inKnitFolder(tracker.fileId))) return { error: LEFT_FOLDER };
    const ref = { fileId: tracker.fileId, sheetId: tracker.sheetGid };
    const { headerRow } = tracker.config;
    const check = async () =>
      checkStructure(
        await source.readStructure(ref, headerRow),
        tracker.config,
      );
    // No problem at all is a column a recreate that stopped halfway already added: it carries
    // on and writes the IDs (invariant 8).
    const before = await check();
    if (before && before.kind !== "missing_knit_id_column")
      return { error: recreateRefusal(before) };
    await source.ensureKnitColumns(ref, headerRow);
    const added = await check();
    if (added) return { error: recreateRefusal(added) };
    const result = await recreateKnitIds({ store, source }, tracker);
    const { error } = await createServiceClient().rpc("set_tracker_state", {
      p_tracker_id: trackerId,
      p_state: "active",
      p_reason: null,
    });
    if (error)
      return {
        error: error.message.includes("file_outside_folder")
          ? LEFT_FOLDER
          : "The Knit IDs were written, but the tracker could not be resumed. Try again.",
      };
    pullLater([trackerId]);
    refresh();
    return {
      error: null,
      notice: `Recreated ${result.written} Knit IDs${result.cleared > 0 ? `; ${result.cleared} rows moved meanwhile and get new IDs` : ""}.`,
    };
  } catch (error) {
    if (sheetMissing(error))
      return {
        error:
          "Knit cannot recreate the Knit ID column yet: the sheet or tab cannot be found. Restore the sheet or its tab, then try again.",
      };
    logEvent("admin.recreate_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return { error: "The Knit ID column could not be recreated. Try again." };
  }
}

// ---------------------------------------------------------------------------------------
// Needs Attention (12.8): map status, link owner, dismiss, retry

async function markAttention(itemId: number, state: "resolved" | "dismissed") {
  const supabase = await getSupabase();
  await supabase.rpc("admin_set_attention_state", {
    p_id: itemId,
    p_state: state,
  });
}

export async function setAttentionState(
  itemId: number,
  state: "resolved" | "dismissed",
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({ itemId: ItemId, state: z.enum(["resolved", "dismissed"]) })
    .safeParse({ itemId, state });
  if (!parsed.success) return INVALID;
  await markAttention(parsed.data.itemId, parsed.data.state);
  refresh();
  return { error: null };
}

/** 6.8, N19(d): map an unmapped word; saving the map pulls the tracker again. */
export async function mapStatusWord(
  itemId: number,
  trackerId: string,
  word: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const args = z
    .object({ itemId: ItemId, trackerId: TrackerId, word: StatusWord })
    .safeParse({ itemId, trackerId, word });
  if (!args.success) return INVALID;
  const status = KnitUserStatus.safeParse(form.get("status"));
  if (!status.success) return { error: "Choose a Knit status." };
  const tracker = await loadTracker(args.data.trackerId);
  const config = tracker ? TrackerConfig.safeParse(tracker.draft) : null;
  if (!tracker || !config?.success)
    return { error: "This tracker cannot be changed now." };
  // saveDraft pulls an active tracker again (and records the pull it is owed).
  const error = await saveDraft(tracker, {
    statusMap: {
      ...config.data.statusMap,
      [normaliseKey(args.data.word)]: status.data,
    },
  });
  if (error) return { error };
  await markAttention(args.data.itemId, "resolved");
  refresh();
  return { error: null };
}

/** 6.7: link an owner name to a user, or mark it a known non-user, then pull again. */
export async function linkOwnerName(
  name: string,
  itemId: number | null,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const args = z
    .object({ name: OwnerName, itemId: ItemId.nullable() })
    .safeParse({ name, itemId });
  if (!args.success) return INVALID;
  const target = text(form, "user");
  const userId = target === "non_user" ? null : z.uuid().safeParse(target).data;
  if (userId === undefined)
    return { error: "Choose a user, or mark the name as a non-user." };
  const { error } = await createServiceClient()
    .from("people_aliases")
    .upsert(
      {
        alias_norm: normaliseKey(args.data.name),
        display: args.data.name,
        user_id: userId,
      },
      { onConflict: "alias_norm" },
    );
  if (error) return { error: "The name could not be saved. Try again." };
  if (args.data.itemId !== null)
    await markAttention(args.data.itemId, "resolved");
  pullLater();
  refresh();
  return { error: null };
}

/** 10.4: send failed write-backs again (all, or one task's). */
export async function retryWrites(taskId: string | null): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z.uuid().nullable().safeParse(taskId);
  if (!parsed.success) return INVALID;
  const supabase = await getSupabase();
  const { error } = await supabase.rpc("admin_retry_writes", {
    p_task_id: parsed.data,
  });
  if (error) return { error: messageFor(error) };
  pushLater();
  refresh();
  return { error: null };
}

// ---------------------------------------------------------------------------------------
// Backlog review (6.11)

export async function backlogAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({
      taskIds: z.array(z.uuid()).min(1),
      action: z.enum(["bring_to_today", "mark_done", "cancel"]),
      reason: z.string().trim().max(REASON_MAX_LENGTH),
    })
    .safeParse({
      taskIds: form.getAll("taskId").map(String),
      action: form.get("action"),
      reason: String(form.get("reason") ?? ""),
    });
  if (!parsed.success) return { error: "Select tasks and an action." };
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("backlog_action", {
    p_task_ids: parsed.data.taskIds,
    p_action: parsed.data.action,
    p_reason: parsed.data.reason || null,
  });
  if (error) return { error: messageFor(error) };
  pushLater();
  refresh();
  const changed = z.object({ changed: z.number() }).safeParse(data);
  return {
    error: null,
    notice: ((n: number) => `${n} ${n === 1 ? "task" : "tasks"} updated.`)(
      changed.success ? changed.data.changed : 0,
    ),
  };
}

// ---------------------------------------------------------------------------------------
// People (12.8): users are created by the admin only (D6)

export async function createUser(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(80),
      email: z.email().max(320),
      role: z.enum(["admin", "member"]),
      password: z.string().min(8).max(200),
      alias: z.string().trim().max(80),
    })
    .safeParse({
      name: form.get("name"),
      email: text(form, "email").toLowerCase(),
      role: form.get("role"),
      password: String(form.get("password") ?? ""),
      alias: String(form.get("alias") ?? ""),
    });
  if (!parsed.success)
    return {
      error: "Give a name, an email and a password of at least 8 characters.",
    };
  const service = createServiceClient();
  const { data, error } = await service.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
    user_metadata: { name: parsed.data.name },
  });
  if (error || !data.user)
    return {
      error: "The user could not be created. The email may already be in use.",
    };
  const { error: rowError } = await service.from("app_users").insert({
    id: data.user.id,
    name: parsed.data.name,
    email: parsed.data.email,
    role: parsed.data.role,
    is_active: true,
  });
  if (rowError) {
    // Undo the login just made, so trying again starts clean (it could not sign in anyway).
    const { error: undoError } = await service.auth.admin.deleteUser(
      data.user.id,
    );
    if (undoError)
      logEvent("admin.create_user_undo_failed", {
        error: errorSummary(undoError),
      });
    return { error: "The user could not be saved. Try again." };
  }
  if (parsed.data.alias) {
    const { error: aliasError } = await service.from("people_aliases").upsert(
      {
        alias_norm: normaliseKey(parsed.data.alias),
        display: parsed.data.alias,
        user_id: data.user.id,
      },
      { onConflict: "alias_norm" },
    );
    if (aliasError) {
      refresh();
      return {
        error: null,
        notice: `Created ${parsed.data.email}, but the name in trackers could not be saved. Add it under Names in trackers.`,
      };
    }
    pullLater();
  }
  refresh();
  return { error: null, notice: `Created ${parsed.data.email}.` };
}

/**
 * Deactivating also stops the account signing in; the admin cannot deactivate themselves
 * (N19 f). The two writes are ordered so a half-done change always leaves the person locked
 * out rather than let in: deactivating marks the Knit user inactive (which ends their access
 * to every screen at once) before blocking the login; reactivating unblocks the login before
 * marking them active.
 */
export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<FormState> {
  const { user, refusal } = await adminGate();
  if (!user) return refusal;
  const parsed = z
    .object({ userId: UserId, active: z.boolean() })
    .safeParse({ userId, active });
  if (!parsed.success) return INVALID;
  if (user.id === parsed.data.userId)
    return { error: "You cannot deactivate your own account." };
  const service = createServiceClient();
  const login = () =>
    service.auth.admin.updateUserById(parsed.data.userId, {
      ban_duration: parsed.data.active ? "none" : "876000h",
    });
  const row = () =>
    service
      .from("app_users")
      .update({ is_active: parsed.data.active })
      .eq("id", parsed.data.userId);
  if (parsed.data.active) {
    if ((await login()).error)
      return { error: "The account could not be reactivated. Try again." };
    if ((await row()).error)
      return { error: "The account could not be reactivated. Try again." };
  } else {
    if ((await row()).error)
      return { error: "The account could not be deactivated. Try again." };
    if ((await login()).error) {
      refresh();
      return {
        error:
          "Their access is removed, but their sign-in could not be blocked. Try again.",
      };
    }
  }
  refresh();
  return { error: null };
}

export async function resetPassword(
  userId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const id = UserId.safeParse(userId);
  if (!id.success) return INVALID;
  const password = z.string().min(8).max(200).safeParse(form.get("password"));
  if (!password.success) return { error: "Use at least 8 characters." };
  const { error } = await createServiceClient().auth.admin.updateUserById(
    id.data,
    {
      password: password.data,
    },
  );
  return error
    ? { error: "The password could not be changed." }
    : { error: null, notice: "Password changed." };
}

/** 6.7: add an alias, or change who it points to. */
export async function saveAlias(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const name = text(form, "alias");
  if (!name) return { error: "Type the name as the trackers write it." };
  return linkOwnerName(name, null, _previous, form);
}

// ---------------------------------------------------------------------------------------
// Holidays (12.8): saving refreshes the calendar (trigger), then due dates are recomputed for
// open task-days by a forced pull (locked ones never change).

/**
 * 12.8, N19(g): a holiday on a date with open tasks is saved only once the admin confirmed
 * the number Knit showed them, and only while that number is still the number of open tasks
 * the date has.
 */
export async function addHoliday(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  const parsed = z
    .object({
      day: z.string().refine(isLocalDate),
      name: z.string().trim().min(1).max(80),
    })
    .safeParse({ day: form.get("day"), name: form.get("name") });
  if (!parsed.success) return { error: "Give a date and a name." };
  const supabase = await getSupabase();
  // 12.8: warn when open tasks sit on or are planned for that date.
  const { data: impact, error: impactError } = await supabase.rpc(
    "holiday_impact",
    { p_day: parsed.data.day },
  );
  const counts = z
    .object({ openTaskDays: z.number(), plannedTasks: z.number() })
    .safeParse(impact);
  if (impactError || !counts.success)
    return {
      error:
        "Knit could not count the open tasks on this date. Try again in a moment.",
    };
  const affected = Math.max(counts.data.openTaskDays, counts.data.plannedTasks);
  if (affected > 0 && form.get("confirm") !== String(affected))
    return {
      error: `${affected} open ${affected === 1 ? "task is" : "tasks are"} on or planned for this date. Their due dates will be recomputed; closed days do not change. Tick the box and save again.`,
      confirm: affected,
    };
  const { error } = await supabase
    .from("holidays")
    .upsert(
      { day: parsed.data.day, name: parsed.data.name },
      { onConflict: "day" },
    );
  if (error) return { error: messageFor(error) };
  pullLater();
  refresh();
  return { error: null, notice: `Saved ${parsed.data.name}.` };
}

export async function removeHoliday(day: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!isLocalDate(day)) return INVALID;
  const supabase = await getSupabase();
  await supabase.from("holidays").delete().eq("day", day);
  pullLater();
  refresh();
  return { error: null };
}

/** 6.2: extend the working-day calendar by a year. */
export async function extendCalendar(calendarEnd: string): Promise<FormState> {
  const denied = await adminRefusal();
  if (denied) return denied;
  if (!isLocalDate(calendarEnd)) return INVALID;
  const year = Number(calendarEnd.slice(0, 4)) + 1;
  const supabase = await getSupabase();
  await supabase.rpc("refresh_calendar", {
    p_from: `${year}-01-01`,
    p_to: `${year}-12-31`,
  });
  refresh();
  return { error: null };
}
