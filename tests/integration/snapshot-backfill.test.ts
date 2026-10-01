import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { createTask, createTracker } from "./support/builders";
import { useTestDb, type Db } from "./support/db";

// PRD N28, N60, N44, invariant 8: the one-off data fix that records JSON null as the status of
// snapshots taken while their word was unmapped. The migration ran when the database was set
// up; here its SQL runs again on seeded rows, inside the test's transaction.

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../supabase/migrations/20261001120200_snapshot_records_unmapped_words.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

async function taskWith(
  db: Db,
  trackerId: string,
  snapshot: Record<string, unknown>,
): Promise<string> {
  const id = await createTask(db, { trackerId });
  await db.query("update tasks set source_snapshot = $2::jsonb where id = $1", [
    id,
    JSON.stringify(snapshot),
  ]);
  return id;
}

/** The admin mapped "copy ready" to Done (N19 d) after an unmapped_status item was raised. */
async function mappedSince(db: Db, state: string): Promise<string> {
  const id = await createTracker(db, { state });
  await db.query(
    `update trackers set config = jsonb_set(config, '{statusMap,copy ready}', '"done"') where id = $1`,
    [id],
  );
  await db.query(
    `insert into attention_items (tracker_id, kind, dedupe_key, state, resolved_at)
     values ($1, 'unmapped_status', 'unmapped_status:copy ready', 'resolved', now())`,
    [id],
  );
  return id;
}

describe("migration: snapshots of unmapped words record null (N28, N60)", () => {
  const db = useTestDb();
  const ids: Record<string, string> = {};
  const trackers: Record<string, string> = {};

  beforeEach(async () => {
    trackers.unmapped = await createTracker(db());
    trackers.mapped = await mappedSince(db(), "active");
    trackers.draft = await mappedSince(db(), "draft");
    ids.unmapped = await taskWith(db(), trackers.unmapped, {
      statusKey: "copy ready",
      status: "yet_to_start",
      completedOn: null,
    });
    ids.yetToStart = await taskWith(db(), trackers.unmapped, {
      statusKey: "not started",
      status: "yet_to_start",
      completedOn: null,
    });
    ids.legacy = await taskWith(db(), trackers.unmapped, {
      statusKey: "copy ready",
      completedOn: null,
    });
    ids.mapped = await taskWith(db(), trackers.mapped, {
      statusKey: "copy ready",
      status: "yet_to_start",
      completedOn: null,
    });
    ids.draft = await taskWith(db(), trackers.draft, {
      statusKey: "copy ready",
      status: "yet_to_start",
      completedOn: null,
    });
  });

  const snapshots = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(ids).map(async ([name, id]) => {
          const [row] = await db().query<{ s: unknown }>(
            "select source_snapshot as s from tasks where id = $1",
            [id],
          );
          return [name, row!.s] as const;
        }),
      ),
    );
  const requested = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(trackers).map(async ([name, id]) => {
          const [row] = await db().query<{ n: string }>(
            "select pull_requested::text as n from trackers where id = $1",
            [id],
          );
          return [name, Number(row!.n)] as const;
        }),
      ),
    );

  it("nulls unmapped and first-mapped words, keeps Yet to Start, and owes a pull only where a word was mapped", async () => {
    const before = await requested();
    await db().query(MIGRATION);
    const nullStatus = (statusKey: string) => ({
      statusKey,
      status: null,
      completedOn: null,
    });
    expect(await snapshots()).toEqual({
      unmapped: nullStatus("copy ready"),
      yetToStart: {
        statusKey: "not started",
        status: "yet_to_start",
        completedOn: null,
      },
      legacy: nullStatus("copy ready"),
      mapped: nullStatus("copy ready"),
      draft: nullStatus("copy ready"),
    });
    expect(await requested()).toEqual({
      unmapped: before.unmapped,
      mapped: before.mapped! + 1,
      draft: before.draft,
    });
  });

  it("running it again changes nothing", async () => {
    await db().query(MIGRATION);
    const once = { snapshots: await snapshots(), requested: await requested() };
    await db().query(MIGRATION);
    expect({
      snapshots: await snapshots(),
      requested: await requested(),
    }).toEqual(once);
  });
});
