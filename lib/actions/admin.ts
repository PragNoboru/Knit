"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";

import {
  loadSheetDeps,
  loadTabData,
  loadTracker,
  type AdminTracker,
} from "@/lib/admin/data";
import { TRACKER_COLORS } from "@/lib/domain/cards";
import {
  KnitUserStatus,
  normaliseKey,
  TrackerConfig,
  USER_STATUSES,
  type UserStatus,
} from "@/lib/domain/config";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";
import {
  CLEAR_CELL,
  DraftConfig,
  draftProblems,
  finalConfig,
  LEAVE_UNCHANGED,
  nextColour,
  statusChoices,
  statusField,
  unmappedChoices,
  writeBackField,
  type WizardStep,
} from "@/lib/domain/wizard";
import { messageFor } from "@/lib/errors";
import { withJobLease } from "@/lib/jobs/cron";
import { getCurrentUser, getSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { discover } from "@/lib/sync/discover";
import { errorSummary, logEvent } from "@/lib/sync/log";
import { pullAll, pullTracker } from "@/lib/sync/pull";
import { pushDue } from "@/lib/sync/push";
import { recreateKnitIds } from "@/lib/sync/recreate-ids";
import { isLocalDate } from "@/lib/time";

// PRD 11, 12.8, 13: the admin's actions. Each checks the caller is the active admin first;
// rules (tracker states, backlog, attention, retries) live in the database functions they
// call, and tracker configs are validated with zod before they are saved (8.2).

export interface FormState {
  error: string | null;
  notice?: string | null;
}

const NOT_ADMIN: FormState = { error: "Only the admin can do this." };
const isAdmin = async () => (await getCurrentUser())?.isAdmin === true;

/** A forced pull of some or all active trackers after the response (7.3), under the lease. */
function pullLater(trackerIds?: string[]) {
  after(async () => {
    try {
      await withJobLease("pull", 60, ({ store, source, deadline }) =>
        pullAll({ store, source }, { force: true, trackerIds, deadline }),
      );
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
 * stay complete, and saving it runs the structure check and a forced pull (11: editing).
 */
async function saveDraft(
  tracker: AdminTracker,
  patch: Partial<DraftConfig>,
): Promise<string | null> {
  const draft = DraftConfig.parse({ ...tracker.draft, ...patch });
  if (tracker.state !== "draft") {
    const complete = finalConfig(draft);
    if (!complete.success)
      return "This change would leave the tracker incomplete.";
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
  fileId: string,
  sheetId: number,
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user?.isAdmin) return NOT_ADMIN;
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
  if (!(await isAdmin())) return NOT_ADMIN;
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

/** 11 step 4. Write targets may not hold formulas (N6). */
export async function saveColumns(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const tracker = await loadTracker(trackerId);
  if (!tracker?.draft.headerRow)
    return { error: "Choose the header row first." };
  const { structure } = await loadTabData(tracker.ref, tracker.draft.headerRow);
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
  const titleTemplate = text(form, "titleTemplate") || `{${title}}`;
  const error = await saveDraft(tracker, {
    columns: {
      date,
      title,
      statusRead,
      statusWrite,
      completedOn,
      owner: pick("owner"),
      sourceRef: pick("sourceRef"),
      critical: criticalHeader ? { header: criticalHeader, truthy } : null,
    },
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
  });
  if (error) return { error };
  afterSave(tracker, "columns");
}

/** 11 step 5: every word mapped, and a write-back value for every Knit status. */
export async function saveStatuses(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const tracker = await loadTracker(trackerId);
  const statusHeader = tracker?.draft.columns?.statusRead;
  if (!tracker?.draft.headerRow || !statusHeader)
    return { error: "Map the columns first." };
  const { structure, rows } = await loadTabData(
    tracker.ref,
    tracker.draft.headerRow,
  );
  const choices = statusChoices(
    rows,
    statusHeader,
    structure.validations[normaliseKey(statusHeader)]?.options ?? null,
  );
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
  const writeBack = {} as Record<UserStatus, string | null>;
  for (const status of USER_STATUSES) {
    const value = String(form.get(writeBackField(status)) ?? "");
    if (value === "")
      return { error: "Choose a write-back value for every Knit status." };
    writeBack[status] =
      value === LEAVE_UNCHANGED ? null : value === CLEAR_CELL ? "" : value;
  }
  const error = await saveDraft(tracker, {
    statusMap,
    cancelReasons,
    writeBack,
  });
  if (error) return { error };
  afterSave(tracker, "statuses");
}

/** 11 step 6. */
export async function saveOwners(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
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

/** 11 step 7. The go-live date can change only before activation. */
export async function saveDetails(
  trackerId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
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
        ? { go_live_date: parsed.data.goLive }
        : {}),
    })
    .eq("id", tracker.id);
  if (error) return { error: "The change could not be saved. Try again." };
  afterSave(tracker, "details");
}

/**
 * 11 step 9: adds the Knit ID and Knit Note columns, activates the tracker and runs its first
 * pull (which writes the IDs). Then the backlog review (step 10) when old rows are open.
 */
export async function activateTracker(trackerId: string): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const tracker = await loadTracker(trackerId);
  if (!tracker || tracker.state !== "draft")
    return { error: "Only a tracker being set up can be activated." };
  const problems = draftProblems(tracker.draft);
  const config = finalConfig(tracker.draft);
  if (problems.length > 0 || !config.success)
    return { error: problems[0]?.problem ?? "The setup is not complete." };
  const service = createServiceClient();
  try {
    const { error } = await service
      .from("trackers")
      .update({ config: config.data })
      .eq("id", tracker.id);
    if (error) throw new Error(error.message);
    const { store, source } = await loadSheetDeps();
    await source.ensureKnitColumns(tracker.ref, config.data.headerRow);
    await setTrackerState(tracker.id, "active");
    const run = await withJobLease("pull", 60, async () => {
      const [synced] = await store.trackers({ ids: [tracker.id] });
      return synced
        ? pullTracker({ store, source }, synced, { force: true })
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

export async function pauseTracker(trackerId: string): Promise<void> {
  if (!(await isAdmin())) return;
  await setTrackerState(trackerId, "paused", "Paused by the admin");
  refresh();
}

export async function resumeTracker(trackerId: string): Promise<void> {
  if (!(await isAdmin())) return;
  await setTrackerState(trackerId, "active");
  pullLater([trackerId]);
  pushLater();
  refresh();
}

export async function archiveTracker(trackerId: string): Promise<void> {
  if (!(await isAdmin())) return;
  await setTrackerState(trackerId, "archived");
  redirect("/admin/trackers");
}

/** 12.8 Sync now for one tracker: a forced pull, now. */
export async function syncTracker(trackerId: string): Promise<void> {
  if (!(await isAdmin())) return;
  await withJobLease("pull", 60, async ({ store, source }) => {
    await discover({ store, source });
    return pullAll({ store, source }, { force: true, trackerIds: [trackerId] });
  });
  refresh();
}

/** 11 step 1: Ignore a new sheet, or list it again. */
export async function setFileIgnored(
  fileId: string,
  ignored: boolean,
): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await getSupabase();
  await supabase.rpc("admin_set_file_state", {
    p_file_id: fileId,
    p_state: ignored ? "ignored" : "new",
  });
  refresh();
}

/** 14: recreate a deleted Knit ID column after the preview, then resume. */
export async function recreateKnitIdColumn(
  trackerId: string,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  try {
    const { store, source } = await loadSheetDeps();
    const [tracker] = await store.trackers({
      states: ["paused"],
      ids: [trackerId],
    });
    if (!tracker)
      return {
        error: "Only a paused tracker's Knit ID column can be recreated.",
      };
    const result = await recreateKnitIds({ store, source }, tracker);
    await setTrackerState(trackerId, "active");
    pullLater([trackerId]);
    refresh();
    return {
      error: null,
      notice: `Recreated ${result.written} Knit IDs${result.cleared > 0 ? `; ${result.cleared} rows moved meanwhile and get new IDs` : ""}.`,
    };
  } catch (error) {
    logEvent("admin.recreate_failed", {
      tracker: trackerId,
      error: errorSummary(error),
    });
    return { error: "The Knit ID column could not be recreated. Try again." };
  }
}

// ---------------------------------------------------------------------------------------
// Needs Attention (12.8): map status, link owner, dismiss, retry

export async function setAttentionState(
  itemId: number,
  state: "resolved" | "dismissed",
): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await getSupabase();
  await supabase.rpc("admin_set_attention_state", {
    p_id: itemId,
    p_state: state,
  });
  refresh();
}

/** 6.8: map an unmapped word; the tracker is pulled again at once. */
export async function mapStatusWord(
  itemId: number,
  trackerId: string,
  word: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const status = KnitUserStatus.safeParse(form.get("status"));
  if (!status.success) return { error: "Choose a Knit status." };
  const tracker = await loadTracker(trackerId);
  const config = tracker ? TrackerConfig.safeParse(tracker.draft) : null;
  if (!tracker || !config?.success)
    return { error: "This tracker cannot be changed now." };
  const error = await saveDraft(tracker, {
    statusMap: { ...config.data.statusMap, [normaliseKey(word)]: status.data },
  });
  if (error) return { error };
  await setAttentionState(itemId, "resolved");
  pullLater([trackerId]);
  return { error: null };
}

/** 6.7: link an owner name to a user, or mark it a known non-user, then pull again. */
export async function linkOwnerName(
  name: string,
  itemId: number | null,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const target = text(form, "user");
  const userId = target === "non_user" ? null : z.uuid().safeParse(target).data;
  if (userId === undefined)
    return { error: "Choose a user, or mark the name as a non-user." };
  const { error } = await createServiceClient()
    .from("people_aliases")
    .upsert(
      { alias_norm: normaliseKey(name), display: name.trim(), user_id: userId },
      { onConflict: "alias_norm" },
    );
  if (error) return { error: "The name could not be saved. Try again." };
  if (itemId !== null) await setAttentionState(itemId, "resolved");
  pullLater();
  refresh();
  return { error: null };
}

/** 10.4: send failed write-backs again (all, or one task's). */
export async function retryWrites(taskId: string | null): Promise<void> {
  if (!(await isAdmin())) return;
  const supabase = await getSupabase();
  await supabase.rpc("admin_retry_writes", { p_task_id: taskId });
  pushLater();
  refresh();
}

// ---------------------------------------------------------------------------------------
// Backlog review (6.11)

export async function backlogAction(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
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
  if (!(await isAdmin())) return NOT_ADMIN;
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
  if (rowError) return { error: "The user could not be saved. Try again." };
  if (parsed.data.alias) {
    await service.from("people_aliases").upsert(
      {
        alias_norm: normaliseKey(parsed.data.alias),
        display: parsed.data.alias,
        user_id: data.user.id,
      },
      { onConflict: "alias_norm" },
    );
    pullLater();
  }
  refresh();
  return { error: null, notice: `Created ${parsed.data.email}.` };
}

/** Deactivating also stops the account signing in; the admin cannot deactivate themselves. */
export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<void> {
  const user = await getCurrentUser();
  if (!user?.isAdmin || user.id === userId) return;
  const service = createServiceClient();
  await service.auth.admin.updateUserById(userId, {
    ban_duration: active ? "none" : "876000h",
  });
  await service
    .from("app_users")
    .update({ is_active: active })
    .eq("id", userId);
  refresh();
}

export async function resetPassword(
  userId: string,
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const password = z.string().min(8).max(200).safeParse(form.get("password"));
  if (!password.success) return { error: "Use at least 8 characters." };
  const { error } = await createServiceClient().auth.admin.updateUserById(
    userId,
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

export async function addHoliday(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  if (!(await isAdmin())) return NOT_ADMIN;
  const parsed = z
    .object({
      day: z.string().refine(isLocalDate),
      name: z.string().trim().min(1).max(80),
    })
    .safeParse({ day: form.get("day"), name: form.get("name") });
  if (!parsed.success) return { error: "Give a date and a name." };
  const supabase = await getSupabase();
  // 12.8: warn when open tasks sit on or are planned for that date.
  const { data: impact } = await supabase.rpc("holiday_impact", {
    p_day: parsed.data.day,
  });
  const counts = z
    .object({ openTaskDays: z.number(), plannedTasks: z.number() })
    .safeParse(impact);
  const affected = counts.success
    ? Math.max(counts.data.openTaskDays, counts.data.plannedTasks)
    : 0;
  if (affected > 0 && form.get("confirm") !== "1")
    return {
      error: `${affected} open ${affected === 1 ? "task is" : "tasks are"} on or planned for this date. Their due dates will be recomputed; closed days do not change. Tick the box and save again.`,
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

export async function removeHoliday(day: string): Promise<void> {
  if (!(await isAdmin()) || !isLocalDate(day)) return;
  const supabase = await getSupabase();
  await supabase.from("holidays").delete().eq("day", day);
  pullLater();
  refresh();
}

/** 6.2: extend the working-day calendar by a year. */
export async function extendCalendar(calendarEnd: string): Promise<void> {
  if (!(await isAdmin()) || !isLocalDate(calendarEnd)) return;
  const year = Number(calendarEnd.slice(0, 4)) + 1;
  const supabase = await getSupabase();
  await supabase.rpc("refresh_calendar", {
    p_from: `${year}-01-01`,
    p_to: `${year}-12-31`,
  });
  refresh();
}
