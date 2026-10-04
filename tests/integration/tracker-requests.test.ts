import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createUser, fixtureTrackerConfig } from "./support/builders";
import { queryAs, setToday, useTestDb, type Actor } from "./support/db";

// PRD N83 to N87, 8.1, 9.1, 9.2: requests for a new tracker. RLS of tracker_requests, the
// throttle, record_tracker_request's checks, resolution when the file's tracker becomes active,
// and dismissal with a reason.

const SHEET = "application/vnd.google-apps.spreadsheet";

describe("tracker requests (N83 to N87)", () => {
  const db = useTestDb();
  let admin: string;
  let alice: string;
  let bob: string;
  let fileId: string;

  const as = (id: string): Actor => ({ kind: "user", id });
  const service: Actor = { kind: "service" };
  const anon: Actor = { kind: "anon" };

  async function driveFile(
    options: { state?: string; mime?: string } = {},
  ): Promise<string> {
    const id = `file-${randomUUID()}`;
    await db().query(
      `insert into drive_files (file_id, name, mime_type, state) values ($1, 'Brand X', $2, $3)`,
      [id, options.mime ?? SHEET, options.state ?? "new"],
    );
    return id;
  }

  async function tracker(file: string, state: string): Promise<string> {
    const rows = await db().query<{ id: string }>(
      `insert into trackers (file_id, sheet_gid, tab_name, name, color, state, config, go_live_date)
       values ($1, 0, 'Tasks', 'Brand X', 'amber', $2, $3::jsonb, '2026-10-05') returning id`,
      [
        file,
        state,
        JSON.stringify(fixtureTrackerConfig("Knit Standard v2 · Example")),
      ],
    );
    return rows[0]!.id;
  }

  async function record(
    user: string,
    file: string,
    note: string | null = "For Brand X",
  ): Promise<{ outcome: string; id?: number }> {
    const [row] = await queryAs<{ v: { outcome: string; id?: number } }>(
      db(),
      service,
      "select record_tracker_request($1, $2, 7, 'Brand X tracker', 'knit-standard-v2', 10, 2, $3) as v",
      [user, file, note],
    );
    return row!.v;
  }

  const setState = (trackerId: string, state: string) =>
    queryAs(db(), service, "select set_tracker_state($1, $2)", [
      trackerId,
      state,
    ]);

  const request = async (id: number) =>
    (
      await db().query<{
        state: string;
        tracker_id: string | null;
        dismiss_reason: string | null;
        resolved_by: string | null;
        resolved_at: string | null;
      }>(
        "select state, tracker_id, dismiss_reason, resolved_by, resolved_at from tracker_requests where id = $1",
        [id],
      )
    )[0]!;

  const items = (file: string) =>
    db().query<{
      state: string;
      tracker_id: string | null;
      detail: Record<string, unknown>;
    }>(
      "select state, tracker_id, detail from attention_items where kind = 'tracker_request' and dedupe_key = $1 order by id",
      [`tracker_request:${file}`],
    );

  beforeEach(async () => {
    await setToday(db(), "2026-10-05");
    admin = await createUser(db(), { role: "admin", name: "Admin" });
    alice = await createUser(db(), { name: "Alice" });
    bob = await createUser(db(), { name: "Bob" });
    fileId = await driveFile();
  });

  describe("record_tracker_request", () => {
    it("is refused to signed-in callers, the admin too", async () => {
      for (const user of [alice, admin])
        await expect(
          queryAs(
            db(),
            as(user),
            "select record_tracker_request($1, $2, 7, 'X', 'knit-standard-v2', 10, 0, null)",
            [user, fileId],
          ),
        ).rejects.toThrow(/permission denied/);
    });

    it("saves the request and one open tracker_request item under no tracker", async () => {
      const sent = await record(alice, fileId);
      expect(sent.outcome).toBe("sent");
      const [row] = await db().query(
        "select requested_by, file_id, sheet_gid::int as gid, file_name, template_id, task_count, unknown_names, note, state from tracker_requests where id = $1",
        [sent.id],
      );
      expect(row).toEqual({
        requested_by: alice,
        file_id: fileId,
        gid: 7,
        file_name: "Brand X tracker",
        template_id: "knit-standard-v2",
        task_count: 10,
        unknown_names: 2,
        note: "For Brand X",
        state: "open",
      });
      const [item, ...more] = await items(fileId);
      expect(more).toEqual([]);
      expect(item).toMatchObject({ state: "open", tracker_id: null });
      expect(item!.detail).toEqual({
        requestId: sent.id,
        userId: alice,
        fileId,
        fileName: "Brand X tracker",
        taskCount: 10,
        unknownNames: 2,
        templateId: "knit-standard-v2",
        note: "For Brand X",
      });
      // admin_attention names the requester (12.8).
      const [attention] = await queryAs<{
        v: { kind: string; reporter: string; tracker: null }[];
      }>(db(), as(admin), "select admin_attention() as v");
      expect(
        attention!.v.find((a) => a.kind === "tracker_request"),
      ).toMatchObject({ reporter: "Alice", tracker: null });
    });

    it("keeps an empty note as none", async () => {
      const sent = await record(alice, fileId, "   ");
      const [row] = await db().query(
        "select note from tracker_requests where id = $1",
        [sent.id],
      );
      expect(row).toEqual({ note: null });
    });

    it("allows one open request per file, whoever sends it (N87)", async () => {
      expect((await record(alice, fileId)).outcome).toBe("sent");
      expect((await record(bob, fileId)).outcome).toBe("already_requested");
      expect((await record(alice, fileId)).outcome).toBe("already_requested");
      await expect(
        queryAs(
          db(),
          service,
          `insert into tracker_requests (requested_by, file_id, sheet_gid, file_name, template_id, task_count)
           values ($1, $2, 0, 'Again', 'knit-standard-v2', 1)`,
          [bob, fileId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      // Another file is its own request.
      expect((await record(bob, await driveFile())).outcome).toBe("sent");
    });

    it("answers for a file that has a tracker in any state", async () => {
      const draft = await driveFile();
      await tracker(draft, "draft");
      expect((await record(alice, draft)).outcome).toBe("setting_up");
      const active = await driveFile({ state: "connected" });
      await tracker(active, "active");
      expect((await record(alice, active)).outcome).toBe("already_tracker");
      const paused = await driveFile({ state: "connected" });
      await tracker(paused, "paused");
      expect((await record(alice, paused)).outcome).toBe("already_tracker");
      const archived = await driveFile({ state: "connected" });
      await tracker(archived, "archived");
      expect((await record(alice, archived)).outcome).toBe("archived");
      const count = await db().query(
        "select count(*)::int as n from tracker_requests where file_id = any($1)",
        [[draft, active, paused, archived]],
      );
      expect(count).toEqual([{ n: 0 }]);
    });

    it("refuses a file outside the folder, a file that is not a Google Sheet and an inactive user", async () => {
      expect(
        (await record(alice, await driveFile({ state: "left_folder" })))
          .outcome,
      ).toBe("not_in_folder");
      expect((await record(alice, "file-never-listed")).outcome).toBe(
        "not_in_folder",
      );
      expect(
        (
          await record(
            alice,
            await driveFile({ state: "not_a_sheet", mime: "application/pdf" }),
          )
        ).outcome,
      ).toBe("not_a_sheet");
      expect(
        (await record(alice, await driveFile({ mime: "application/pdf" })))
          .outcome,
      ).toBe("not_a_sheet");
      const gone = await createUser(db(), { name: "Gone", active: false });
      expect((await record(gone, fileId)).outcome).toBe("not_allowed");
      // An ignored sheet can still be requested; Set up still works for it (N86).
      expect(
        (await record(alice, await driveFile({ state: "ignored" }))).outcome,
      ).toBe("sent");
    });

    it("refuses a request without tasks or with an over-long note", async () => {
      await expect(
        queryAs(
          db(),
          service,
          "select record_tracker_request($1, $2, 0, 'X', 'knit-standard-v2', 0, 0, null)",
          [alice, fileId],
        ),
      ).rejects.toThrow(/invalid_request/);
      await expect(record(alice, fileId, "x".repeat(281))).rejects.toThrow(
        /invalid_request/,
      );
    });
  });

  describe("row level security (9.2)", () => {
    let aliceRequest: number;

    beforeEach(async () => {
      aliceRequest = (await record(alice, fileId)).id!;
    });

    const visible = async (actor: Actor) =>
      (
        await queryAs<{ id: string }>(
          db(),
          actor,
          "select id from tracker_requests",
        )
      ).map((r) => Number(r.id));

    it("a person reads their own requests, the admin all, nobody else any", async () => {
      expect(await visible(as(alice))).toEqual([aliceRequest]);
      expect(await visible(as(bob))).toEqual([]);
      expect(await visible(as(admin))).toContain(aliceRequest);
      await db().query("update app_users set is_active = false where id = $1", [
        alice,
      ]);
      expect(await visible(as(alice))).toEqual([]);
      await expect(visible(anon)).rejects.toThrow(/permission denied/);
    });

    it("refuses every write from signed-in callers, and any access to the checks", async () => {
      for (const sql of [
        `insert into tracker_requests (requested_by, file_id, sheet_gid, file_name, template_id, task_count)
         values ('${alice}', '${fileId}', 0, 'X', 'knit-standard-v2', 1)`,
        `update tracker_requests set state = 'dismissed', dismiss_reason = 'x', resolved_at = now()`,
        "delete from tracker_requests",
        "select * from tracker_request_checks",
        `insert into tracker_request_checks (user_id) values ('${alice}')`,
      ]) {
        for (const user of [alice, admin])
          await expect(queryAs(db(), as(user), sql)).rejects.toThrow(
            /permission denied/,
          );
      }
    });
  });

  describe("claim_tracker_check (N87)", () => {
    const claim = async (user: string) =>
      (
        await queryAs<{ v: boolean }>(
          db(),
          as(user),
          "select claim_tracker_check() as v",
        )
      )[0]!.v;

    it("allows 5 checks in 10 minutes, then refuses, for that person only", async () => {
      for (let i = 0; i < 5; i += 1) expect(await claim(alice)).toBe(true);
      expect(await claim(alice)).toBe(false);
      expect(await claim(bob)).toBe(true);
      const [count] = await db().query(
        "select count(*)::int as n from tracker_request_checks where user_id = $1",
        [alice],
      );
      expect(count).toEqual({ n: 5 });
    });

    it("does not count checks older than 10 minutes, and drops those older than a day", async () => {
      await db().query(
        `insert into tracker_request_checks (user_id, checked_at)
         select $1, now() - interval '11 minutes' from generate_series(1, 5)`,
        [alice],
      );
      await db().query(
        "insert into tracker_request_checks (user_id, checked_at) values ($1, now() - interval '2 days')",
        [alice],
      );
      expect(await claim(alice)).toBe(true);
      const [count] = await db().query(
        "select count(*)::int as n from tracker_request_checks where user_id = $1",
        [alice],
      );
      expect(count).toEqual({ n: 6 });
    });

    it("is refused to an inactive person and to anon", async () => {
      const gone = await createUser(db(), { name: "Gone", active: false });
      await expect(claim(gone)).rejects.toThrow(/not_allowed/);
      await expect(
        queryAs(db(), anon, "select claim_tracker_check()"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("resolution when the file becomes a tracker (N86)", () => {
    it("a draft leaves it open; activation connects it and resolves its item", async () => {
      const sent = await record(alice, fileId);
      const draft = await tracker(fileId, "draft");
      expect((await request(sent.id!)).state).toBe("open");
      await setState(draft, "active");
      expect(await request(sent.id!)).toMatchObject({
        state: "connected",
        tracker_id: draft,
        dismiss_reason: null,
      });
      expect((await request(sent.id!)).resolved_at).not.toBeNull();
      expect((await items(fileId)).map((i) => i.state)).toEqual(["resolved"]);

      // Paused and active again: nothing more changes.
      await setState(draft, "paused");
      await setState(draft, "active");
      expect((await request(sent.id!)).state).toBe("connected");
      expect((await items(fileId)).map((i) => i.state)).toEqual(["resolved"]);
    });

    it("a tracker inserted as active also connects it", async () => {
      const sent = await record(alice, fileId);
      const id = await tracker(fileId, "active");
      expect(await request(sent.id!)).toMatchObject({
        state: "connected",
        tracker_id: id,
      });
    });

    it("activating a tracker of another file touches nothing", async () => {
      const sent = await record(alice, fileId);
      const other = await driveFile();
      const draft = await tracker(other, "draft");
      await setState(draft, "active");
      expect((await request(sent.id!)).state).toBe("open");
      expect((await items(fileId)).map((i) => i.state)).toEqual(["open"]);
    });

    it("a request dismissed before the file is connected stays dismissed", async () => {
      const sent = await record(alice, fileId);
      await queryAs(
        db(),
        as(admin),
        "select admin_dismiss_tracker_request($1, 'Not a brand we run')",
        [sent.id],
      );
      const draft = await tracker(fileId, "draft");
      await setState(draft, "active");
      expect(await request(sent.id!)).toMatchObject({
        state: "dismissed",
        tracker_id: null,
        dismiss_reason: "Not a brand we run",
      });
    });
  });

  describe("dismissal (N86)", () => {
    let sent: number;

    beforeEach(async () => {
      sent = (await record(alice, fileId)).id!;
    });

    const dismiss = (user: string, reason: string) =>
      queryAs(db(), as(user), "select admin_dismiss_tracker_request($1, $2)", [
        sent,
        reason,
      ]);

    it("dismisses the request and its item, keeping the reason the person sees", async () => {
      await dismiss(admin, "  Use the Sapiens tracker instead  ");
      expect(await request(sent)).toMatchObject({
        state: "dismissed",
        dismiss_reason: "Use the Sapiens tracker instead",
        resolved_by: admin,
      });
      expect((await items(fileId)).map((i) => i.state)).toEqual(["dismissed"]);
      const [mine] = await queryAs(
        db(),
        as(alice),
        "select state, dismiss_reason from tracker_requests where id = $1",
        [sent],
      );
      expect(mine).toEqual({
        state: "dismissed",
        dismiss_reason: "Use the Sapiens tracker instead",
      });
    });

    it("is refused to a member, without a reason, with a long one, and a second time", async () => {
      await expect(dismiss(alice, "Mine")).rejects.toThrow(/not_allowed/);
      await expect(dismiss(admin, "   ")).rejects.toThrow(/reason_required/);
      await expect(dismiss(admin, "x".repeat(141))).rejects.toThrow(
        /reason_too_long/,
      );
      expect((await request(sent)).state).toBe("open");
      await dismiss(admin, "x".repeat(140));
      await expect(dismiss(admin, "Again")).rejects.toThrow(/request_not_open/);
    });

    it("the generic Dismiss refuses a tracker_request item", async () => {
      const [item] = await db().query<{ id: string }>(
        "select id from attention_items where kind = 'tracker_request' and dedupe_key = $1",
        [`tracker_request:${fileId}`],
      );
      for (const state of ["dismissed", "resolved"])
        await expect(
          queryAs(db(), as(admin), "select admin_set_attention_state($1, $2)", [
            item!.id,
            state,
          ]),
        ).rejects.toThrow(/request_needs_reason/);
      expect((await items(fileId)).map((i) => i.state)).toEqual(["open"]);
    });

    it("a new request for the same file is accepted afterwards", async () => {
      await dismiss(admin, "Fill in the dates first");
      const again = await record(bob, fileId);
      expect(again.outcome).toBe("sent");
      expect((await items(fileId)).map((i) => i.state)).toEqual([
        "dismissed",
        "open",
      ]);
    });
  });

  describe("admin_trackers: Requested by (N86, 11 step 1)", () => {
    const requestedBy = async () => {
      const [row] = await queryAs<{
        v: { files: { fileId: string; requestedBy: string | null }[] };
      }>(db(), as(admin), "select admin_trackers() as v");
      return row!.v.files.find((f) => f.fileId === fileId)?.requestedBy;
    };

    it("names the requester of an open request, and nobody once it is answered", async () => {
      expect(await requestedBy()).toBeNull();
      const sent = await record(alice, fileId);
      expect(await requestedBy()).toBe("Alice");
      await queryAs(
        db(),
        as(admin),
        "select admin_dismiss_tracker_request($1, 'No')",
        [sent.id],
      );
      expect(await requestedBy()).toBeNull();
      await record(bob, fileId);
      expect(await requestedBy()).toBe("Bob");
      const draft = await tracker(fileId, "draft");
      await db().query(
        "update drive_files set state = 'connected' where file_id = $1",
        [fileId],
      );
      expect(await requestedBy()).toBe("Bob");
      await setState(draft, "active");
      expect(await requestedBy()).toBeUndefined();
    });
  });
});
