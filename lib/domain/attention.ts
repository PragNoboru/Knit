import { formatDay, isLocalDate } from "@/lib/time";

import { KNIT_STATUSES, type KnitStatus } from "./config";
import { STATUS_LABELS } from "./status";

/**
 * PRD 12.8 Needs Attention: each item says what happened and where. The kinds are the ones
 * of 8.1 attention_items; `detail` is what the job that raised the item recorded.
 */

export const ATTENTION_TITLES: Record<string, string> = {
  unmapped_status: "Unmapped status",
  unknown_owner: "Unknown owner",
  bad_date: "Date cannot be read",
  past_date_added: "Added after its date",
  conflict: "Knit and the sheet disagree",
  duplicate_knit_id: "Duplicate Knit ID",
  missing_header: "Column missing",
  missing_tab: "Sheet or tab missing",
  missing_knit_id_column: "Knit ID column missing",
  formula_column: "Formula column",
  write_blocked: "Write refused",
  row_not_found: "Row not found",
  member_report: "Report from a member",
  calendar_ending: "Calendar ending",
  write_misplaced: "Write may be on the wrong row",
};

const DATE_REASONS: Record<string, string> = {
  weekday_mismatch: "the weekday does not match the date",
  not_a_date: "it is not a real date",
  range_end_before_start: "the range ends before it starts",
  unparseable: "Knit cannot read it as a date",
  empty: "the date is empty",
  outside_calendar: "it is outside the working-day calendar",
  restored_after_close:
    "the row came back after Knit had closed that day, so the task has no open day",
};

const str = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

const status = (value: unknown) => {
  const text = str(value);
  return (KNIT_STATUSES as readonly string[]).includes(text)
    ? STATUS_LABELS[text as KnitStatus]
    : text;
};

const day = (value: unknown) => {
  const text = str(value);
  return isLocalDate(text) ? formatDay(text) : text;
};

/** One sentence for an item. */
export function describeAttention(
  kind: string,
  detail: Record<string, unknown>,
  reporter: string | null = null,
): string {
  switch (kind) {
    case "unmapped_status":
      return `The status "${str(detail.word) || "(blank)"}" is not mapped, so its rows count as Yet to Start.`;
    case "unknown_owner":
      return `"${str(detail.name)}" is not a known person.`;
    case "bad_date":
      return `The date "${str(detail.value)}" cannot be used: ${DATE_REASONS[str(detail.reason)] ?? "Knit cannot read it"}.`;
    case "past_date_added":
      return `Added with a due date already past (${day(detail.dueDate)}), so it starts today as a spillover.`;
    case "conflict":
      if (detail.reason === "reopened_in_source")
        return `The sheet reopened a task Knit has closed ("${str(detail.sourceWord)}"). Knit kept ${status(detail.knit)}.`;
      return `Knit says ${status(detail.knit)}, the sheet says "${str(detail.sheet ?? detail.source)}". Knit's value was kept.`;
    case "duplicate_knit_id":
      return `This row had a Knit ID already used ${detail.otherTracker ? "in another tracker" : "by another row"}, so it got a new one.`;
    case "missing_header":
      return detail.duplicate
        ? `Column "${str(detail.header)}" appears more than once. The tracker is paused.`
        : `Column "${str(detail.header)}" is not found. The tracker is paused.`;
    case "missing_tab":
      return "The sheet or its tab cannot be found. The tracker is paused.";
    case "missing_knit_id_column":
      return "The Knit ID column is missing. The tracker is paused until it is recreated.";
    case "formula_column":
      return `Column "${str(detail.header)}" holds formulas, so Knit cannot write to it.`;
    case "write_blocked":
      return `The sheet refused this write-back ${str(detail.attempts)} times: ${str(detail.error)}.`;
    case "row_not_found":
      return "The task's row is no longer in the sheet, so its change could not be written.";
    case "member_report":
      return `${reporter ?? "A member"} reported: "${str(detail.text)}"`;
    case "calendar_ending":
      return `The working-day calendar ends on ${day(detail.last)}. Extend it on the Holidays page.`;
    case "write_misplaced":
      if (detail.reason === "knit_id_lost")
        return `Rows moved while Knit was adding Knit IDs, and the Knit ID of row ${str(detail.row)} could not be put back. Its task may show as removed and come back as a new one.`;
      if (detail.reason === "unverified")
        return `Knit wrote to rows ${Array.isArray(detail.rows) ? detail.rows.map(str).join(", ") : ""} but could not read them back to check. If rows were moved just then, check those rows.`;
      return `Rows moved while Knit was writing, so row ${str(detail.row)} got values meant for another task (${Array.isArray(detail.headers) ? detail.headers.map(str).join(", ") : ""}). Knit could not undo them: check that row.`;
    default:
      return kind;
  }
}

/** The sheet row an item is about, when it names one. */
export function attentionRow(
  detail: Record<string, unknown>,
  taskRow: number | null,
): number | null {
  const row = Number(detail.row);
  return Number.isInteger(row) && row > 0 ? row : taskRow;
}

/** 12.8: items grouped by tracker, then kind, in the order they came. */
export function groupAttention<
  T extends { kind: string; tracker: { id: string; name: string } | null },
>(items: readonly T[]) {
  const groups = new Map<
    string,
    { tracker: T["tracker"]; kinds: Map<string, T[]> }
  >();
  for (const item of items) {
    const key = item.tracker?.id ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { tracker: item.tracker, kinds: new Map() };
      groups.set(key, group);
    }
    const list = group.kinds.get(item.kind) ?? [];
    list.push(item);
    group.kinds.set(item.kind, list);
  }
  return [...groups.values()].map((group) => ({
    tracker: group.tracker,
    kinds: [...group.kinds.entries()].map(([kind, list]) => ({
      kind,
      title: ATTENTION_TITLES[kind] ?? kind,
      items: list,
    })),
  }));
}
