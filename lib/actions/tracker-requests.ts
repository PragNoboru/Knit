"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import {
  checkTrackerRequest,
  findingLines,
  NOTE_MAX_LENGTH,
  REQUEST_COPY,
  refusalText,
  sentLines,
  sheetFileId,
  type Finding,
  type RequestRefusal,
} from "@/lib/domain/tracker-request";
import { SIGNED_OUT_ERROR } from "@/lib/errors";
import { loadTemplateLink } from "@/lib/guide";
import { jobDeps } from "@/lib/jobs/cron";
import { getCurrentUser, getSupabase } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { logEvent } from "@/lib/sync/log";
import {
  CHECK_BUDGET_MS,
  errorCode,
  readSheetForRequest,
} from "@/lib/tracker-request";

// PRD N83 to N88, 13: "Check and send" on the Guide. Any active signed-in person, the admin
// too, sends the admin a sheet made from the template. The checks of N84 run in order and stop
// at the first that fails: the ones that need only the database first (they do not count
// toward the limit), then claim_tracker_check, then the Google reads within 40 s, then the dry
// run of the standard setup; a sheet that passes is saved by record_tracker_request in one
// transaction, which tells the admin (N86). The action catches every error and answers in a
// sentence. It logs ids, outcomes, counts and error codes only: never the link, the file id,
// the sheet's name, the note, a cell or an error message (N88).

export interface RequestFormState {
  error: string | null;
  notice?: string | null;
  /** N85: the lines under "Sent to the admin.". */
  sent?: string[];
  /** N85: the findings to fix, one line each, under the error. */
  problems?: string[];
}

const Input = z.object({
  url: z.string().max(2000),
  note: z.string().max(20_000).optional(),
});

const TrackerStates = z.array(z.object({ state: z.string() }));
const RecordResult = z.object({
  outcome: z.string(),
  id: z.coerce.number().optional(),
});

const refused = (refusal: RequestRefusal, header?: string) => ({
  outcome: refusal,
  state: { error: refusalText(refusal, header) } satisfies RequestFormState,
});

/** N88: findings as kinds and counts, for the log ("bad_dates:2,no_task_id:1"). */
const findingCounts = (findings: readonly Finding[]) =>
  findings.map((f) => `${f.kind}:${f.rows.length}`).join(",");

/** The outcomes of record_tracker_request that are refusals (N84, N86). */
const RECORD_REFUSALS: Record<string, RequestRefusal> = {
  // This check's own listing showed the file, so a listing recorded just after it by another
  // discover is the likely cause: try again (N88).
  not_in_folder: "read_failed",
  not_a_sheet: "not_a_sheet",
  setting_up: "setting_up",
  already_tracker: "already_tracker",
  archived: "archived",
  already_requested: "already_requested",
};

export async function requestTracker(
  // useActionState passes the form's last state; this action reads only the form.
  _previous: RequestFormState,
  form: FormData,
): Promise<RequestFormState> {
  const started = Date.now();
  let userId: string | null = null;
  try {
    const user = await getCurrentUser();
    if (!user) return { error: SIGNED_OUT_ERROR };
    userId = user.id;
    const result = await check(user.id, form, started);
    logEvent("tracker_request.checked", {
      user: user.id,
      outcome: result.outcome,
      ...(result.findings ? { findings: result.findings } : {}),
      ...(result.error ? result.error : {}),
      ms: Date.now() - started,
    });
    if (result.outcome === "sent") refresh();
    return result.state;
  } catch (error) {
    logEvent("tracker_request.failed", {
      user: userId,
      ...errorCode(error),
      ms: Date.now() - started,
    });
    return { error: refusalText("failed") };
  }
}

interface CheckResult {
  outcome: string;
  state: RequestFormState;
  findings?: string;
  error?: { code: string; status?: number };
}

async function check(
  userId: string,
  form: FormData,
  started: number,
): Promise<CheckResult> {
  // N84, 9.3: the fields, checked with zod. A file or an over-long value is refused.
  const parsed = Input.safeParse({
    url: form.get("url") ?? "",
    note: form.get("note") ?? undefined,
  });
  if (!parsed.success)
    return parsed.error.issues.some((issue) => issue.path[0] === "url")
      ? refused("invalid_link")
      : refused("note_too_long");
  const fileId = sheetFileId(parsed.data.url);
  if (fileId === null) return refused("invalid_link");
  const note = (parsed.data.note ?? "").trim();
  if ([...note].length > NOTE_MAX_LENGTH) return refused("note_too_long");

  // Without Google, and without counting toward the limit (N87).
  const template = await loadTemplateLink();
  if (template?.fileId === fileId) return refused("blank_template");
  const service = createServiceClient();
  const trackers = await service
    .from("trackers")
    .select("state")
    .eq("file_id", fileId);
  if (trackers.error) throw trackers.error;
  const states = TrackerStates.parse(trackers.data ?? []).map((t) => t.state);
  if (states.includes("draft")) return refused("setting_up");
  if (states.some((s) => s !== "archived")) return refused("already_tracker");
  if (states.length > 0) return refused("archived");
  const open = await service
    .from("tracker_requests")
    .select("id")
    .eq("file_id", fileId)
    .eq("state", "open")
    .limit(1);
  if (open.error) throw open.error;
  if ((open.data ?? []).length > 0) return refused("already_requested");

  // N87: 5 checks per person in any 10 minutes, with the person's own session.
  const claim = await (await getSupabase()).rpc("claim_tracker_check");
  if (claim.error) throw claim.error;
  if (claim.data !== true) return refused("limit");

  // N84, N88: Google, read only. Every Google request of the check, discover's listing
  // included, stops 40 s after the check started, so the check answers well within the
  // Guide's maxDuration.
  const deadline = started + CHECK_BUDGET_MS;
  const read = await readSheetForRequest(
    fileId,
    await jobDeps({ googleDeadline: deadline }),
    deadline,
  );
  if (!read.ok)
    return {
      ...refused(read.refusal),
      ...(read.error ? { error: read.error } : {}),
    };

  const result = checkTrackerRequest(read);
  if (result.kind === "refused") return refused(result.refusal, result.header);
  if (result.kind === "findings")
    return {
      outcome: "findings",
      findings: findingCounts(result.findings),
      state: {
        error: REQUEST_COPY.findingsIntro,
        problems: findingLines(result.findings),
      },
    };

  // N83, N86: saved and the admin told, in one transaction, with the checks made again there.
  const saved = await service.rpc("record_tracker_request", {
    p_user_id: userId,
    p_file_id: fileId,
    p_sheet_gid: read.sheetGid,
    p_file_name: read.fileName,
    p_template_id: result.template.id,
    p_task_count: result.taskCount,
    // N86: how many names Knit does not know, not how many rows name them.
    p_unknown_names: result.unknownNames,
    p_note: note === "" ? null : note,
  });
  if (saved.error) throw saved.error;
  const outcome = RecordResult.parse(saved.data).outcome;
  if (outcome !== "sent") {
    const refusal = RECORD_REFUSALS[outcome] ?? "failed";
    return { ...refused(refusal), outcome: `record_${outcome}` };
  }
  return {
    outcome: "sent",
    findings: `unknown_names:${result.unknownNames}`,
    state: {
      error: null,
      notice: REQUEST_COPY.sent,
      sent: sentLines({
        fileName: read.fileName,
        taskCount: result.taskCount,
        template: result.template,
        unknownNameRows: result.unknownNameRows,
      }),
    },
  };
}
