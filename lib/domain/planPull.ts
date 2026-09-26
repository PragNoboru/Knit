import type { LocalDate } from "@/lib/time";

import type { KnitStatus, TrackerConfig, UserStatus } from "./config";
import type { NormalisedRow, SourceSnapshot } from "./rows";
import { isFinal, writeBackFor } from "./status";

/**
 * PRD 10.2 step 6: planPull compares what the sheet says with what Knit holds and returns the
 * changes to make, as plain JSON that apply_pull_plan executes in one transaction. Pure: the
 * database state, the rows and `today` are parameters. Locked task-days are never in a plan.
 *
 * Rules: 6.3 to 6.8 and the three-way merge of 10.3, with N9 (open-ended tasks), N11
 * (removed rows) and the go-live rule of 6.11.
 */

export type DateKind = "single" | "window" | "open";
export type TaskDayOrigin = "planned" | "spillover" | "backlog" | "completion";

export interface PlanTaskDay {
  id: string;
  day: LocalDate;
  status: KnitStatus;
  spillIndex: number;
  origin: TaskDayOrigin;
  reason: string | null;
  locked: boolean;
}

/** A task as the database holds it, loaded by the pull job for one tracker. */
export interface PlanTask {
  id: string;
  title: string;
  subtitle: string | null;
  details: Record<string, string>;
  sourceRef: string | null;
  critical: boolean;
  ownerRaw: string | null;
  plannedRaw: string | null;
  rowHint: number | null;
  dateKind: DateKind | null;
  plannedStart: LocalDate | null;
  plannedEnd: LocalDate | null;
  dueDate: LocalDate | null;
  status: UserStatus;
  statusReason: string | null;
  sourceStatusRaw: string | null;
  completedOn: LocalDate | null;
  historyOnly: boolean;
  removedAtSource: boolean;
  sourceSnapshot: SourceSnapshot | null;
  /** 10.3: hub_changed_at > source_synced_at, or a pending write-back exists. */
  hubChanged: boolean;
  assignees: string[];
  /** Every task-day, locked ones included, in date order. */
  taskDays: PlanTaskDay[];
}

export interface PlanContext {
  trackerId: string;
  goLiveDate: LocalDate;
  today: LocalDate;
  config: TrackerConfig;
}

export interface TaskFields {
  title: string;
  subtitle: string | null;
  details: Record<string, string>;
  sourceRef: string | null;
  critical: boolean;
  ownerRaw: string | null;
  plannedRaw: string | null;
  rowHint: number | null;
  dateKind: DateKind | null;
  plannedStart: LocalDate | null;
  plannedEnd: LocalDate | null;
  dueDate: LocalDate | null;
  status: UserStatus;
  statusReason: string | null;
  sourceStatusRaw: string | null;
  completedOn: LocalDate | null;
  historyOnly: boolean;
  sourceSnapshot: SourceSnapshot;
}

export interface TaskUpdate {
  id: string;
  set: Partial<TaskFields> & { removedAtSource?: null };
  /** The sheet's values were taken in: set source_synced_at to now (10.3). */
  sourceSynced: boolean;
}

export interface TaskDayInsert {
  taskId: string;
  day: LocalDate;
  status: UserStatus;
  spillIndex: number;
  origin: TaskDayOrigin;
  reason: string | null;
  statusChangedOn: LocalDate | null;
}

export interface TaskDayUpdate {
  id: string;
  set: Partial<{
    day: LocalDate;
    status: UserStatus;
    reason: string | null;
    statusChangedOn: LocalDate;
    spillIndex: number;
    origin: TaskDayOrigin;
  }>;
}

export type AttentionKind =
  | "unmapped_status"
  | "unknown_owner"
  | "bad_date"
  | "past_date_added"
  | "conflict";

export interface AttentionPlan {
  kind: AttentionKind;
  dedupeKey: string;
  taskId: string | null;
  detail: Record<string, unknown>;
}

export interface EventPlan {
  taskId: string;
  taskDayId: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
}

export interface OutboxPlan {
  taskId: string;
  statusValue: string | null;
  completedOn: LocalDate | null;
}

export interface PullPlan {
  trackerId: string;
  today: LocalDate;
  taskInserts: (TaskFields & { id: string })[];
  taskUpdates: TaskUpdate[];
  taskDayInserts: TaskDayInsert[];
  taskDayUpdates: TaskDayUpdate[];
  assigneeSets: { taskId: string; userIds: string[] }[];
  removals: string[];
  outbox: OutboxPlan[];
  attention: AttentionPlan[];
  events: EventPlan[];
  stats: {
    rows: number;
    inserted: number;
    updated: number;
    removed: number;
    skipped: number;
    conflicts: number;
  };
}

const REMOVED_REASON = "Removed at source";

/** JSON with object keys sorted, so key order (which jsonb does not keep) never counts. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    [...a].sort().every((v, i) => v === [...b].sort()[i])
  );
}

class Planner {
  readonly plan: PullPlan;
  private readonly attentionKeys = new Set<string>();

  constructor(private readonly ctx: PlanContext) {
    this.plan = {
      trackerId: ctx.trackerId,
      today: ctx.today,
      taskInserts: [],
      taskUpdates: [],
      taskDayInserts: [],
      taskDayUpdates: [],
      assigneeSets: [],
      removals: [],
      outbox: [],
      attention: [],
      events: [],
      stats: {
        rows: 0,
        inserted: 0,
        updated: 0,
        removed: 0,
        skipped: 0,
        conflicts: 0,
      },
    };
  }

  private get today(): LocalDate {
    return this.ctx.today;
  }

  attention(
    kind: AttentionKind,
    key: string,
    taskId: string | null,
    detail: Record<string, unknown>,
  ) {
    const dedupeKey = `${kind}:${key}`;
    if (this.attentionKeys.has(dedupeKey)) return;
    this.attentionKeys.add(dedupeKey);
    this.plan.attention.push({ kind, dedupeKey, taskId, detail });
  }

  /** 6.8, 6.7: one item per distinct unmapped word or unknown name per tracker. */
  rowAttention(row: NormalisedRow) {
    if (!row.status.mapped) {
      this.attention("unmapped_status", row.status.key, null, {
        word: row.statusRaw,
      });
    }
    for (const name of row.unknownOwners) {
      this.attention("unknown_owner", name, null, { name });
    }
  }

  /** 6.6 "Marked done in the sheet": the sheet's completed-on value if mapped and not in the future. */
  completedOnFor(row: NormalisedRow): LocalDate {
    return row.completedOn && row.completedOn <= this.today
      ? row.completedOn
      : this.today;
  }

  statusFieldsFrom(row: NormalisedRow) {
    const status = row.status.status;
    return {
      status,
      statusReason: status === "cancelled" ? row.status.cancelReason : null,
      completedOn: status === "done" ? this.completedOnFor(row) : null,
    };
  }

  /** The date fields of a usable row, or null when the row's date cannot be used. */
  usableDates(row: NormalisedRow) {
    const kind = row.date.kind;
    if (kind === "empty" || kind === "invalid" || row.outsideCalendar)
      return null;
    return {
      dateKind: kind,
      plannedStart: row.date.start,
      plannedEnd: kind === "window" ? row.date.end : null,
      dueDate: row.dueDate,
    };
  }

  badDate(row: NormalisedRow, taskId: string | null) {
    const reason =
      row.date.kind === "invalid"
        ? row.date.reason
        : row.date.kind === "empty"
          ? "empty"
          : "outside_calendar";
    this.attention("bad_date", row.knitId, taskId, {
      row: row.rowNumber,
      value: row.plannedRaw,
      reason,
    });
  }

  /** A task-day for a task that has none open: on its due date, or today as a spillover (6.6). */
  placeTaskDay(
    taskId: string,
    dueDate: LocalDate,
    status: UserStatus,
    reason: string | null,
    existing: readonly PlanTaskDay[],
    spillFloor: number,
  ) {
    const future = dueDate >= this.today;
    const day = future ? dueDate : this.today;
    const taken = existing.find((d) => d.day === day);
    if (taken) {
      if (taken.locked) {
        this.attention("bad_date", taskId, taskId, {
          reason: "day_already_closed",
          day,
        });
        return;
      }
      this.plan.taskDayUpdates.push({
        id: taken.id,
        set: { status, reason, statusChangedOn: this.today },
      });
      return;
    }
    this.plan.taskDayInserts.push({
      taskId,
      day,
      status,
      spillIndex: future ? spillFloor : Math.max(1, spillFloor),
      origin: future ? (spillFloor > 0 ? "spillover" : "planned") : "spillover",
      reason,
      statusChangedOn: isFinal(status) ? this.today : null,
    });
    if (!future) this.attention("past_date_added", taskId, taskId, { dueDate });
  }

  newTask(row: NormalisedRow) {
    const dates = this.usableDates(row);
    if (!dates) {
      // 6.3.1, 14: a new row without a usable date is skipped; an invalid one is reported.
      if (row.date.kind !== "empty") this.badDate(row, null);
      this.plan.stats.skipped += 1;
      return;
    }
    const { status, statusReason, completedOn } = this.statusFieldsFrom(row);
    const historyOnly =
      dates.dueDate !== null && dates.dueDate < this.ctx.goLiveDate;

    this.plan.taskInserts.push({
      id: row.knitId,
      title: row.title,
      subtitle: row.subtitle,
      details: row.details,
      sourceRef: row.sourceRef,
      critical: row.critical,
      ownerRaw: row.ownerRaw,
      plannedRaw: row.plannedRaw,
      rowHint: row.rowNumber,
      ...dates,
      status,
      statusReason,
      sourceStatusRaw: row.statusRaw,
      completedOn,
      historyOnly,
      sourceSnapshot: row.snapshot,
    });
    this.plan.stats.inserted += 1;
    if (row.assignees.length > 0) {
      this.plan.assigneeSets.push({
        taskId: row.knitId,
        userIds: row.assignees,
      });
    }

    if (historyOnly) return; // 6.11: history only, no task-day.
    if (dates.dateKind === "open") {
      // N9: an open-ended task gets a task-day only when it is completed.
      if (isFinal(status)) {
        this.plan.taskDayInserts.push({
          taskId: row.knitId,
          day: this.today,
          status,
          spillIndex: 0,
          origin: "completion",
          reason: statusReason,
          statusChangedOn: this.today,
        });
      }
      return;
    }
    // 6.4 step 1: one task-day on the due date. 6.6: a new row whose due date has passed gets
    // a spillover on today, unless the sheet already has it finished.
    if (dates.dueDate! < this.today && isFinal(status)) return;
    this.placeTaskDay(row.knitId, dates.dueDate!, status, statusReason, [], 0);
  }

  existingTask(task: PlanTask, row: NormalisedRow) {
    const set: TaskUpdate["set"] = {};
    let sourceSynced = false;

    const content: Partial<TaskFields> = {
      title: row.title,
      subtitle: row.subtitle,
      details: row.details,
      sourceRef: row.sourceRef,
      critical: row.critical,
      ownerRaw: row.ownerRaw,
      plannedRaw: row.plannedRaw,
      rowHint: row.rowNumber,
      sourceStatusRaw: row.statusRaw,
    };
    for (const [key, value] of Object.entries(content) as [
      keyof TaskFields,
      unknown,
    ][]) {
      if (!sameJson(task[key as keyof PlanTask], value)) {
        (set as Record<string, unknown>)[key] = value;
      }
    }

    if (task.removedAtSource) {
      set.removedAtSource = null;
      this.event(
        task.id,
        null,
        "removed_at_source",
        "removed",
        "restored",
        null,
      );
    }

    if (!sameSet(task.assignees, row.assignees)) {
      this.plan.assigneeSets.push({ taskId: task.id, userIds: row.assignees });
    }

    // Dates (6.6): a bad date keeps the last good dates and is reported.
    const dates = this.usableDates(row);
    if (!dates) this.badDate(row, task.id);
    const newDue = dates ? dates.dueDate : task.dueDate;
    const dueChanged = dates !== null && dates.dueDate !== task.dueDate;
    if (dates) {
      for (const key of [
        "dateKind",
        "plannedStart",
        "plannedEnd",
        "dueDate",
      ] as const) {
        if (task[key] !== dates[key])
          (set as Record<string, unknown>)[key] = dates[key];
      }
    }
    const openEnded = (dates ? dates.dateKind : task.dateKind) === "open";

    // 10.3: three-way merge of the status and completed-on values.
    const snapshot = task.sourceSnapshot;
    const sourceChanged = snapshot
      ? row.snapshot.statusKey !== snapshot.statusKey ||
        row.snapshot.completedOn !== snapshot.completedOn
      : row.status.status !== task.status;
    const openDays = task.taskDays.filter((d) => !d.locked);
    const current =
      openDays.find((d) => d.day === this.today) ??
      openDays.find((d) => d.day > this.today) ??
      [...openDays].reverse().find((d) => d.day < this.today) ??
      null;

    let status = task.status;
    let applied = false;
    if (sourceChanged && !task.hubChanged) {
      const incoming = this.statusFieldsFrom(row);
      const reopening =
        isFinal(task.status) &&
        !isFinal(incoming.status) &&
        !current &&
        !openEnded &&
        !task.historyOnly;
      if (reopening) {
        // The sheet reopened a task Knit has closed: Knit cannot place it without a rule (Q6).
        this.attention("conflict", task.id, task.id, {
          reason: "reopened_in_source",
          knit: task.status,
          source: incoming.status,
          sourceWord: row.statusRaw,
        });
        this.plan.stats.conflicts += 1;
      } else {
        if (incoming.status !== task.status) {
          this.event(
            task.id,
            current?.id ?? null,
            "status",
            task.status,
            incoming.status,
            incoming.statusReason,
          );
        }
        set.status = incoming.status;
        set.statusReason = incoming.statusReason;
        set.completedOn = incoming.completedOn;
        set.sourceSnapshot = row.snapshot;
        sourceSynced = true;
        status = incoming.status;
        applied = true;
      }
    } else if (task.hubChanged) {
      // Hub wins in Stages 1 and 2; make sure the write-back is (still) queued.
      this.plan.outbox.push({
        taskId: task.id,
        statusValue: writeBackFor(task.status, this.ctx.config),
        completedOn: task.completedOn,
      });
      if (sourceChanged) {
        this.attention("conflict", task.id, task.id, {
          knit: task.status,
          source: row.status.status,
          sourceWord: row.statusRaw,
        });
        this.plan.stats.conflicts += 1;
      }
    } else if (!snapshot) {
      set.sourceSnapshot = row.snapshot;
      sourceSynced = true;
    }

    this.taskDays(task, row, {
      set,
      status,
      applied,
      dueChanged,
      newDue,
      openEnded,
      current,
      dates,
    });

    if (Object.keys(set).length > 0 || sourceSynced) {
      this.plan.taskUpdates.push({ id: task.id, set, sourceSynced });
      this.plan.stats.updated += 1;
    }
  }

  private taskDays(
    task: PlanTask,
    row: NormalisedRow,
    s: {
      set: TaskUpdate["set"];
      status: UserStatus;
      applied: boolean;
      dueChanged: boolean;
      newDue: LocalDate | null;
      openEnded: boolean;
      current: PlanTaskDay | null;
      dates: ReturnType<Planner["usableDates"]>;
    },
  ) {
    const { current, status, applied } = s;
    const reason =
      s.set.statusReason !== undefined ? s.set.statusReason : task.statusReason;

    // 6.11: a history-only row stays history unless its date moves to or past go-live.
    if (task.historyOnly) {
      if (
        s.dates &&
        s.newDue !== null &&
        s.newDue >= this.ctx.goLiveDate &&
        !s.openEnded
      ) {
        s.set.historyOnly = false;
        if (!(s.newDue < this.today && isFinal(status))) {
          this.placeTaskDay(
            task.id,
            s.newDue,
            status,
            reason,
            task.taskDays,
            0,
          );
        }
      }
      return;
    }

    if (s.openEnded) {
      if (current && s.dates && task.dateKind !== "open") {
        this.attention("bad_date", task.id, task.id, {
          reason: "became_open_ended",
          row: row.rowNumber,
        });
      }
      // N9: completing an open-ended task records a completion task-day on today.
      if (applied && isFinal(status) && !current) {
        this.plan.taskDayInserts.push({
          taskId: task.id,
          day: this.today,
          status,
          spillIndex: 0,
          origin: "completion",
          reason,
          statusChangedOn: this.today,
        });
      } else if (applied && current) {
        this.plan.taskDayUpdates.push({
          id: current.id,
          set: { status, reason, statusChangedOn: this.today },
        });
      }
      return;
    }

    if (current) {
      const update: TaskDayUpdate["set"] = {};
      // A restored row gets back the task-day its removal cancelled (6.6).
      const restoring =
        task.removedAtSource &&
        current.status === "cancelled" &&
        current.reason === REMOVED_REASON;
      if ((applied || restoring) && current.status !== status) {
        Object.assign(update, { status, reason, statusChangedOn: this.today });
      }
      // 6.6: a moved planned date moves the open task-day (never one waiting for its close).
      if (
        s.dueChanged &&
        s.newDue !== null &&
        !isFinal(status) &&
        current.day >= this.today
      ) {
        const target = s.newDue >= this.today ? s.newDue : this.today;
        if (target !== current.day) {
          const clash = task.taskDays.find((d) => d.day === target);
          if (clash) {
            this.attention("bad_date", task.id, task.id, {
              reason: "day_already_used",
              day: target,
            });
          } else {
            update.day = target;
            if (s.newDue < this.today) {
              update.spillIndex = Math.max(1, current.spillIndex);
              update.origin = "spillover";
              this.attention("past_date_added", task.id, task.id, {
                dueDate: s.newDue,
              });
            }
            this.event(
              task.id,
              current.id,
              "due_date",
              task.dueDate,
              s.newDue,
              null,
            );
          }
        }
      }
      if (Object.keys(update).length > 0)
        this.plan.taskDayUpdates.push({ id: current.id, set: update });
      return;
    }

    // No open task-day: a task that is still open needs one.
    if (!isFinal(status) && s.newDue !== null && (applied || s.dueChanged)) {
      const spillFloor = task.taskDays.reduce(
        (max, d) => Math.max(max, d.spillIndex),
        0,
      );
      this.placeTaskDay(
        task.id,
        s.newDue,
        status,
        reason,
        task.taskDays,
        task.taskDays.length > 0 ? spillFloor + 1 : 0,
      );
    }
  }

  /** 6.6 "Row deleted": open task-days become cancelled; locked history is untouched. */
  removal(task: PlanTask) {
    this.plan.removals.push(task.id);
    this.plan.stats.removed += 1;
    for (const day of task.taskDays) {
      if (day.locked || day.status === "cancelled") continue;
      this.plan.taskDayUpdates.push({
        id: day.id,
        set: {
          status: "cancelled",
          reason: REMOVED_REASON,
          statusChangedOn: this.today,
        },
      });
    }
    this.event(
      task.id,
      null,
      "removed_at_source",
      null,
      "removed",
      REMOVED_REASON,
    );
  }

  event(
    taskId: string,
    taskDayId: string | null,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    reason: string | null,
  ) {
    this.plan.events.push({
      taskId,
      taskDayId,
      field,
      oldValue,
      newValue,
      reason,
    });
  }
}

export function planPull(
  tasks: readonly PlanTask[],
  rows: readonly NormalisedRow[],
  ctx: PlanContext,
): PullPlan {
  const planner = new Planner(ctx);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();

  for (const row of rows) {
    planner.plan.stats.rows += 1;
    seen.add(row.knitId);
    planner.rowAttention(row);
    const task = byId.get(row.knitId);
    if (task) planner.existingTask(task, row);
    else planner.newTask(row);
  }
  for (const task of tasks) {
    if (!seen.has(task.id) && !task.removedAtSource) planner.removal(task);
  }
  return planner.plan;
}
