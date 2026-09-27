import { createSyncStore, type Rpc } from "@/lib/sync/store";

import type { Db } from "./db";

/**
 * The jobs' SyncStore over the test database session, so jobs run against the real SQL
 * functions inside the test's transaction. Argument types are spelled out for Postgres.
 */
const SIGNATURES: Record<
  string,
  { args: Record<string, string>; returns?: string }
> = {
  knit_today: { args: {}, returns: "text" },
  load_sync_context: { args: {} },
  sync_trackers: { args: { p_states: "tracker_state[]", p_ids: "uuid[]" } },
  load_pull_state: { args: { p_tracker_id: "uuid" } },
  knit_ids_elsewhere: {
    args: { p_tracker_id: "uuid", p_ids: "uuid[]" },
    returns: "text[]",
  },
  record_tab_name: { args: { p_tracker_id: "uuid", p_tab_name: "text" } },
  apply_pull_plan: {
    args: {
      p_tracker_id: "uuid",
      p_expected_state_version: "bigint",
      p_plan: "jsonb",
      p_run_id: "bigint",
      p_source_modified_time: "timestamptz",
    },
  },
  record_drive_listing: { args: { p_files: "jsonb" } },
  pause_tracker: {
    args: {
      p_tracker_id: "uuid",
      p_reason: "text",
      p_kind: "text",
      p_dedupe_key: "text",
      p_detail: "jsonb",
    },
  },
  raise_attention: {
    args: {
      p_tracker_id: "uuid",
      p_task_id: "uuid",
      p_kind: "text",
      p_dedupe_key: "text",
      p_detail: "jsonb",
    },
  },
  next_day_to_close: { args: {}, returns: "text" },
  begin_day_closure: { args: { p_day: "date" } },
  finish_day_closure: { args: { p_day: "date", p_stats: "jsonb" } },
  fail_day_closure: { args: { p_day: "date", p_error: "text" } },
  close_day: { args: { p_day: "date" } },
  enqueue_note_refresh: { args: { p_task_ids: "uuid[]" } },
  archive_rows: { args: { p_day: "date" } },
  outbox_due_count: { args: {} },
  push_claim: { args: { p_limit: "integer", p_task_id: "uuid" } },
  push_result: {
    args: {
      p_outbox_id: "bigint",
      p_ok: "boolean",
      p_snapshot: "jsonb",
      p_error: "text",
      p_status_raw: "text",
    },
  },
  acquire_lease: {
    args: { p_job: "text", p_ttl_seconds: "integer" },
    returns: "text",
  },
  release_lease: { args: { p_job: "text", p_holder: "uuid" } },
  start_sync_run: {
    args: { p_job: "text", p_tracker_id: "uuid" },
    returns: "text",
  },
  finish_sync_run: {
    args: {
      p_id: "bigint",
      p_ok: "boolean",
      p_stats: "jsonb",
      p_error: "text",
    },
  },
};

export function pgRpc(db: Db): Rpc {
  return async (fn, args) => {
    const signature = SIGNATURES[fn] ?? { args: {} };
    const entries = Object.entries(args);
    const call = `public.${fn}(${entries
      .map(
        ([name], i) =>
          `${name} => $${i + 1}::${signature.args[name] ?? "text"}`,
      )
      .join(", ")})`;
    const params = entries.map(([name, value]) => {
      if (value === null || value === undefined) return null;
      if (signature.args[name] === "jsonb") return JSON.stringify(value);
      // A Postgres array literal: both pg and PGlite accept it for array parameters.
      if (Array.isArray(value)) {
        return `{${value.map((v) => `"${String(v).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
      }
      return value;
    });
    const rows = await db.query<{ result: unknown }>(
      `select ${call}${signature.returns ? `::${signature.returns}` : ""} as result`,
      params,
    );
    return rows[0]?.result;
  };
}

export const storeFor = (db: Db) => createSyncStore(pgRpc(db));
