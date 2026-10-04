import "server-only";

import { z } from "zod";

import { calendarFromDays, type WorkingCalendar } from "@/lib/domain/calendar";
import { aliasMap, type AliasMap } from "@/lib/domain/owners";
import {
  findTasksTab,
  type MyTrackerRequest,
} from "@/lib/domain/tracker-request";
import {
  GOOGLE_SHEET_MIME,
  type SheetRow,
  type SheetSource,
  type TabStructure,
} from "@/lib/sheets/types";
import { getSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { discover } from "@/lib/sync/discover";
import { errorCode, logEvent } from "@/lib/sync/log";
import type { SyncStore } from "@/lib/sync/store";
import type { LocalDate } from "@/lib/time";

/**
 * PRD N83, N84, N88: the reads of a request check, and the Guide's list of the person's own
 * requests (N85). The check only reads: discover (which writes its sync run, N45), then the
 * file's drive_files row, then the sheet's tabs, row 1 of its Tasks tab and its rows, and the
 * working-day calendar and the people aliases. Nothing is logged here but codes.
 */

/**
 * N88: the sheet reads must be done this long after the check started. The check's Google
 * requests, discover's listing included, are stopped at the same time (jobDeps' googleDeadline).
 */
export const CHECK_BUDGET_MS = 40_000;

/** A read that did not finish by the deadline (N88). */
export class CheckTimeout extends Error {
  override name = "CheckTimeout";
  readonly code = "timeout";
}

/** `work` raced against the time left until `deadline`; it is dropped, not stopped, after it. */
export function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) {
    work.catch(() => undefined);
    return Promise.reject(new CheckTimeout("deadline passed"));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CheckTimeout("deadline passed"));
    }, left);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** An error as N88 logs it: a code and, for Google, its HTTP status. Never a message. */
export { errorCode };

export type SheetRead =
  | {
      ok: true;
      fileName: string;
      sheetGid: number;
      rawStructure: TabStructure;
      rows: SheetRow[];
      today: LocalDate;
      calendar: WorkingCalendar;
      aliases: AliasMap;
    }
  | {
      ok: false;
      refusal: "not_in_folder" | "not_a_sheet" | "no_tasks_tab" | "read_failed";
      error?: { code: string; status?: number };
    };

const FileRow = z.object({
  name: z.string(),
  mime_type: z.string(),
  state: z.string(),
});

/**
 * N84, N88: lists the folder with discover, run to its end (never raced, so its sync run is
 * always finished; a listing the source stops at the deadline finishes it as failed), then
 * reads the file's drive_files row: a file not listed, or listed as not a Google Sheet, is
 * refused. Then the sheet's reads, raced against the deadline.
 */
export async function readSheetForRequest(
  fileId: string,
  deps: { store: SyncStore; source: SheetSource },
  deadline: number,
): Promise<SheetRead> {
  try {
    await discover(deps);
  } catch (error) {
    return { ok: false, refusal: "read_failed", error: errorCode(error) };
  }
  const { data, error } = await createServiceClient()
    .from("drive_files")
    .select("name, mime_type, state")
    .eq("file_id", fileId)
    .maybeSingle();
  if (error)
    return { ok: false, refusal: "read_failed", error: errorCode(error) };
  const file = FileRow.safeParse(data);
  if (!file.success || file.data.state === "left_folder")
    return { ok: false, refusal: "not_in_folder" };
  if (
    file.data.state === "not_a_sheet" ||
    file.data.mime_type !== GOOGLE_SHEET_MIME
  )
    return { ok: false, refusal: "not_a_sheet" };
  try {
    const tab = findTasksTab(
      await beforeDeadline(deps.source.listTabs(fileId), deadline),
    );
    if (!tab) return { ok: false, refusal: "no_tasks_tab" };
    const ref = { fileId, sheetId: tab.sheetId };
    const [rawStructure, rows, today, context] = await beforeDeadline(
      Promise.all([
        deps.source.readStructure(ref, 1),
        deps.source.readRows(ref, 1),
        deps.store.today(),
        deps.store.loadContext(),
      ]),
      deadline,
    );
    return {
      ok: true,
      fileName: file.data.name,
      sheetGid: tab.sheetId,
      rawStructure,
      rows,
      today,
      calendar: calendarFromDays(context.calendar),
      aliases: aliasMap(context.aliases),
    };
  } catch (error) {
    return { ok: false, refusal: "read_failed", error: errorCode(error) };
  }
}

const MyRequestRow = z.object({
  id: z.coerce.number(),
  file_name: z.string(),
  state: z.enum(["open", "connected", "dismissed"]),
  dismiss_reason: z.string().nullable(),
  created_at: z.string(),
});

/**
 * N85: the person's own last 10 requests, newest first, read with their own session so RLS
 * applies (9.2). A failed read shows none, so the Guide still opens; only the code is logged.
 */
export async function loadMyTrackerRequests(
  userId: string,
): Promise<MyTrackerRequest[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("tracker_requests")
    .select("id, file_name, state, dismiss_reason, created_at")
    .eq("requested_by", userId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    logEvent("guide.tracker_requests_read_failed", { code: error.code });
    return [];
  }
  const rows = z.array(MyRequestRow).safeParse(data ?? []);
  if (!rows.success) {
    logEvent("guide.tracker_requests_read_failed", { code: "invalid_rows" });
    return [];
  }
  return rows.data.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    state: row.state,
    dismissReason: row.dismiss_reason,
    createdAt: row.created_at,
  }));
}
