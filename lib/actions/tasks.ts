"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import { SyncState } from "@/lib/domain/cards";
import { KnitUserStatus } from "@/lib/domain/config";
import { REASON_MAX_LENGTH } from "@/lib/domain/status";
import {
  fail,
  messageFor,
  ok,
  SIGNED_OUT_ERROR,
  type ActionResult,
} from "@/lib/errors";
import { withJobLease } from "@/lib/jobs/cron";
import { getCurrentUser, getSupabase } from "@/lib/supabase/server";
import { discover } from "@/lib/sync/discover";
import { pushTaskNow } from "@/lib/sync/immediate";
import { errorSummary, logEvent } from "@/lib/sync/log";
import { pullAll } from "@/lib/sync/pull";

// PRD 13: the task actions. Every rule (locks, reasons, permissions, the outbox) is enforced
// by the database function each one calls (7.2, invariant 9); these only validate the input
// with zod and turn refusals into plain language.

const StatusChange = z.object({
  taskId: z.uuid(),
  status: KnitUserStatus,
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
});
export type StatusChange = z.input<typeof StatusChange>;

async function syncOf(taskId: string): Promise<SyncState> {
  const supabase = await getSupabase();
  const { data } = await supabase.rpc("task_sync_status", {
    p_task_ids: [taskId],
  });
  const parsed = z.record(z.string(), SyncState).safeParse(data);
  return parsed.success ? (parsed.data[taskId] ?? null) : null;
}

async function changeStatus(
  input: StatusChange,
): Promise<ActionResult<{ sync: SyncState }>> {
  const parsed = StatusChange.safeParse(input);
  if (!parsed.success) return fail("That change is not valid.");
  if (!(await getCurrentUser())) return fail(SIGNED_OUT_ERROR);
  const { taskId, status, reason } = parsed.data;
  const supabase = await getSupabase();
  const { error } = await supabase.rpc("set_task_status", {
    p_task_id: taskId,
    p_status: status,
    p_reason: reason ? reason : null,
  });
  if (error) return fail(messageFor(error));
  // 7.3: push this write-back straight away (best effort, 5 s) once the response is sent;
  // the push job retries every minute.
  after(() => pushTaskNow(taskId));
  refresh();
  return ok({ sync: await syncOf(taskId) });
}

/** 13 setTaskStatus: the status control on every list. */
export async function setTaskStatus(
  input: StatusChange,
): Promise<ActionResult<{ sync: SyncState }>> {
  return changeStatus(input);
}

/** 13 pullForward: the same function on a later task-day (6.5, D3). */
export async function pullForward(
  input: StatusChange,
): Promise<ActionResult<{ sync: SyncState }>> {
  return changeStatus(input);
}

/** 12.3: the Syncing pills, polled every 3 s while a write-back is pending. */
export async function syncStatus(
  taskIds: string[],
): Promise<ActionResult<Record<string, SyncState>>> {
  const parsed = z.array(z.uuid()).max(200).safeParse(taskIds);
  if (!parsed.success) return fail("That request is not valid.");
  if (parsed.data.length === 0) return ok({});
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("task_sync_status", {
    p_task_ids: parsed.data,
  });
  if (error) return fail(messageFor(error));
  const states = z.record(z.string(), SyncState).safeParse(data);
  return states.success ? ok(states.data) : fail(messageFor(null));
}

const SYNC_NOW_SECONDS = 60;

/**
 * 7.3, 13 syncNow: pull the caller's trackers now (the admin's: all of them), at most once
 * per 30 s per user. It runs the pull job's own work, under the pull lease.
 */
export async function syncNow(): Promise<ActionResult<{ message: string }>> {
  const user = await getCurrentUser();
  if (!user) return fail(SIGNED_OUT_ERROR);
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("request_sync_now");
  if (error) return fail(messageFor(error));
  if (data === null)
    return fail("Sync now runs once every 30 seconds. Try again in a moment.");
  const trackerIds = z.array(z.uuid()).parse(data);
  if (trackerIds.length === 0) return ok({ message: "Nothing to sync yet." });
  try {
    const run = await withJobLease(
      "pull",
      SYNC_NOW_SECONDS,
      async ({ store, source, deadline }) => {
        await discover({ store, source });
        return pullAll(
          { store, source },
          { force: true, trackerIds, deadline },
        );
      },
    );
    refresh();
    if (run.skipped)
      return ok({
        message: "A sync is already running. Your tasks update in a moment.",
      });
    const failed = run.result.filter(
      (o) => o.outcome === "failed" || o.outcome === "paused",
    ).length;
    return ok({
      message:
        failed === 0
          ? "Up to date."
          : "Some trackers could not sync. The admin can see why in Sync health.",
    });
  } catch (error) {
    logEvent("sync_now.failed", { error: errorSummary(error) });
    return fail("Sync failed. Knit tries again within 10 minutes.");
  }
}

const IssueReport = z.object({
  taskDayId: z.number().int().positive(),
  text: z.string().trim().min(1).max(500),
});

/** 12.6, 13 reportIssue: a member flags a problem with one of their task-days. */
export async function reportIssue(
  input: z.input<typeof IssueReport>,
): Promise<ActionResult<null>> {
  const parsed = IssueReport.safeParse(input);
  if (!parsed.success) return fail("Describe the problem in a few words.");
  if (!(await getCurrentUser())) return fail(SIGNED_OUT_ERROR);
  const supabase = await getSupabase();
  const { error } = await supabase.rpc("report_issue", {
    p_task_day_id: parsed.data.taskDayId,
    p_text: parsed.data.text,
  });
  return error ? fail(messageFor(error)) : ok(null);
}

const Correction = z.object({
  taskDayId: z.number().int().positive(),
  status: KnitUserStatus,
  reason: z.string().trim().min(1).max(REASON_MAX_LENGTH),
});

const CorrectionResult = z.object({ task: z.object({ id: z.uuid() }) });

/** 6.10, 13 correctTaskDay (admin): the database function checks the caller is the admin. */
export async function correctTaskDay(
  input: z.input<typeof Correction>,
): Promise<ActionResult<null>> {
  const parsed = Correction.safeParse(input);
  if (!parsed.success) return fail("Pick a status and give a short reason.");
  if (!(await getCurrentUser())) return fail(SIGNED_OUT_ERROR);
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("admin_correct_task_day", {
    p_task_day_id: parsed.data.taskDayId,
    p_status: parsed.data.status,
    p_reason: parsed.data.reason,
  });
  if (error) return fail(messageFor(error));
  const result = CorrectionResult.safeParse(data);
  if (result.success) {
    const taskId = result.data.task.id;
    after(() => pushTaskNow(taskId));
  }
  refresh();
  return ok(null);
}
