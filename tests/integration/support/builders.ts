import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Db } from "./db";

/**
 * Builders for integration test data. They insert as the test session's owner (bypassing row
 * level security), the way the pull job and admin actions will; tests then act as users
 * through `act` to exercise the rules.
 */

interface FixtureTracker {
  name: string;
  [key: string]: unknown;
}

const REGISTRY_KEYS = [
  "headerRow",
  "columns",
  "readOnlyColumns",
  "titleTemplate",
  "subtitleTemplate",
  "detailColumns",
  "ownerSeparators",
  "ownerFilter",
  "offDayPolicy",
  "statusMap",
  "cancelReasons",
  "writeBack",
  "completedOnFormat",
] as const;

/** The registry config (PRD 8.2) of one example tracker from fixtures/trackers.config.json. */
export function fixtureTrackerConfig(name: string): Record<string, unknown> {
  const file = fileURLToPath(
    new URL("../../../fixtures/trackers.config.json", import.meta.url),
  );
  const { trackers } = JSON.parse(readFileSync(file, "utf8")) as {
    trackers: FixtureTracker[];
  };
  const tracker = trackers.find((t) => t.name === name);
  if (!tracker) throw new Error(`No fixture tracker named ${name}`);
  return Object.fromEntries(
    REGISTRY_KEYS.filter((key) => key in tracker).map((key) => [
      key,
      tracker[key],
    ]),
  );
}

export const FILING_BUDDY_GOOGLE_ADS = "Filing Buddy · Google Ads";
export const NOBORU_CA_CAMPAIGN = "Noboru · CA Campaign";

export async function createUser(
  db: Db,
  options: { role?: "admin" | "member"; name?: string; active?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const email = `user-${id}@test.knit`;
  await db.query("insert into auth.users (id, email) values ($1, $2)", [
    id,
    email,
  ]);
  await db.query(
    `insert into app_users (id, name, email, role, is_active)
     values ($1, $2, $3, $4, $5)`,
    [
      id,
      options.name ?? "Test user",
      email,
      options.role ?? "member",
      options.active ?? true,
    ],
  );
  return id;
}

export async function createTracker(
  db: Db,
  options: {
    fixture?: string;
    state?: string;
    goLiveDate?: string;
    name?: string;
  } = {},
): Promise<string> {
  const fileId = `file-${randomUUID()}`;
  await db.query(
    `insert into drive_files (file_id, name, mime_type, state)
     values ($1, 'Test sheet', 'application/vnd.google-apps.spreadsheet', 'connected')`,
    [fileId],
  );
  const rows = await db.query<{ id: string }>(
    `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
     values ($1, 0, 'Tasks', $2, 'amber', $3, $4::jsonb, $5)
     returning id`,
    [
      fileId,
      options.name ?? "Test tracker",
      options.state ?? "active",
      JSON.stringify(
        fixtureTrackerConfig(options.fixture ?? FILING_BUDDY_GOOGLE_ADS),
      ),
      options.goLiveDate ?? "2026-09-25",
    ],
  );
  return rows[0]!.id;
}

export interface TaskOptions {
  trackerId: string;
  assignees?: string[];
  title?: string;
  dateKind?: "single" | "window" | "open";
  plannedStart?: string;
  dueDate?: string | null;
  status?: string;
  statusReason?: string | null;
  historyOnly?: boolean;
  removedAtSource?: boolean;
}

export async function createTask(
  db: Db,
  options: TaskOptions,
): Promise<string> {
  const id = randomUUID();
  const dateKind = options.dateKind ?? "single";
  const dueDate =
    options.dueDate === undefined ? "2026-09-30" : options.dueDate;
  await db.query(
    `insert into tasks (id, tracker_id, title, date_kind, planned_start, due_date, status,
                        status_reason, history_only, removed_at_source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $10::boolean then now() end)`,
    [
      id,
      options.trackerId,
      options.title ?? "Test task",
      dateKind,
      options.plannedStart ?? dueDate ?? "2026-09-30",
      dateKind === "open" ? null : dueDate,
      options.status ?? "yet_to_start",
      options.statusReason ?? null,
      options.historyOnly ?? false,
      options.removedAtSource ?? false,
    ],
  );
  for (const userId of options.assignees ?? []) {
    await db.query(
      "insert into task_assignees (task_id, user_id) values ($1, $2)",
      [id, userId],
    );
  }
  return id;
}

export interface TaskDayOptions {
  taskId: string;
  day: string;
  status?: string;
  spillIndex?: number;
  origin?: "planned" | "spillover" | "backlog" | "completion";
  reason?: string | null;
  locked?: boolean;
  statusChangedOn?: string | null;
}

export async function createTaskDay(
  db: Db,
  options: TaskDayOptions,
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into task_days (task_id, day, status, spill_index, origin, reason, locked,
                            locked_at, status_changed_on)
     values ($1, $2, $3, $4, $5, $6, $7::boolean, case when $7::boolean then now() end, $8)
     returning id::text`,
    [
      options.taskId,
      options.day,
      options.status ?? "yet_to_start",
      options.spillIndex ?? 0,
      options.origin ?? "planned",
      options.reason ?? null,
      options.locked ?? false,
      options.statusChangedOn ?? null,
    ],
  );
  return rows[0]!.id;
}

/** A task assigned to `userId` with its planned task-day: the common starting point. */
export async function createPlannedTask(
  db: Db,
  options: TaskOptions & { day?: string },
): Promise<{ taskId: string; taskDayId: string }> {
  const day = options.day ?? options.dueDate ?? "2026-09-30";
  const taskId = await createTask(db, { ...options, dueDate: day });
  const taskDayId = await createTaskDay(db, {
    taskId,
    day,
    status: options.status ?? "yet_to_start",
  });
  return { taskId, taskDayId };
}

export interface TaskDayRow {
  day: string;
  status: string;
  carried_status: string | null;
  spill_index: number;
  origin: string;
  reason: string | null;
  locked: boolean;
  status_changed_on: string | null;
  [key: string]: unknown;
}

/** Every task-day of a task, oldest first, with dates as text. */
export function taskDays(db: Db, taskId: string): Promise<TaskDayRow[]> {
  return db.query<TaskDayRow>(
    `select day::text, status::text, carried_status::text, spill_index, origin, reason,
            locked, status_changed_on::text
     from task_days where task_id = $1 order by day`,
    [taskId],
  );
}
