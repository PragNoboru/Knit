import { beforeEach, describe, expect, it } from "vitest";

import {
  createTask,
  createTracker,
  createUser,
  taskDays,
} from "./support/builders";
import { queryAs, setToday, useTestDb } from "./support/db";

// OPEN QUESTION for Pragaman (N42, 6.11, 6.4, 10.5). Go-live now defaults to the next working
// day, so activation always comes before go-live, and activation opens the backlog review
// straight away when old rows are open. Bring to today, the review's default action, puts the
// task-day on knit_today() (6.11), a day before go-live. knit_close_start() includes that day
// (N31), so close_day locks it not_done and spills it to the go-live day with spill index 2: a
// miss that never happened and a "Spilled 2x" Knit Note. docs/RUNBOOK.md section 4 step 5 tells
// the admin not to use Bring to today before the go-live day until the PRD decides, for
// example, that Bring to today uses the later of knit_today() and the tracker's go-live, or
// that activation opens the tracker page while go-live is in the future.
//
// The first test pins today's behaviour so the gap is on record; the second, an expected
// failure, states what any answer must give. When the PRD decides, replace both.

const SERVICE = { kind: "service" } as const;
const ACTIVATED = "2026-09-30"; // Wed
const GO_LIVE = "2026-10-01"; // Thu, the next working day (N42)

describe("Bring to today before go-live (N42: open question, no PRD rule yet)", () => {
  const db = useTestDb();
  let task: string;

  beforeEach(async () => {
    const admin = await createUser(db(), { role: "admin", name: "Admin" });
    const member = await createUser(db(), { name: "Member" });
    const trackerId = await createTracker(db(), { goLiveDate: GO_LIVE });
    // A row due before go-live, still open in the sheet: history only, in the backlog review.
    task = await createTask(db(), {
      trackerId,
      assignees: [member],
      historyOnly: true,
      dueDate: "2026-09-29",
      status: "in_progress",
    });
    // On activation day the admin applies Bring to today in the review activation opened.
    await setToday(db(), ACTIVATED);
    await queryAs(
      db(),
      { kind: "user", id: admin },
      "select backlog_action($1::uuid[], 'bring_to_today')",
      [`{${task}}`],
    );
    // On go-live day the close job closes every day from knit_close_start(), in order.
    await setToday(db(), GO_LIVE);
    for (;;) {
      const [next] = await queryAs<{ day: string | null }>(
        db(),
        SERVICE,
        "select next_day_to_close()::text as day",
      );
      if (!next?.day) break;
      await queryAs(db(), SERVICE, "select close_day($1)", [next.day]);
      await queryAs(db(), SERVICE, "select finish_day_closure($1, '{}')", [
        next.day,
      ]);
    }
  });

  it("today: the day before go-live closes not done and the task spills onto go-live", async () => {
    expect(
      (await taskDays(db(), task)).map((d) => [
        d.day,
        d.status,
        d.spill_index,
        d.locked,
      ]),
    ).toEqual([
      [ACTIVATED, "not_done", 1, true],
      [GO_LIVE, "in_progress", 2, false],
    ]);
  });

  it.fails("wanted: no task-day before go-live, and no miss", async () => {
    const days = await taskDays(db(), task);
    expect(days.filter((d) => d.day < GO_LIVE)).toEqual([]);
    expect(days.filter((d) => d.status === "not_done")).toEqual([]);
  });
});
