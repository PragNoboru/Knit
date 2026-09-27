import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// Invariant 1, PRD 17 (audit finding 45): the screens take today from the database's clock
// (knit_today), never from the Node process clock, so they agree with Today and with the
// clock CI injects.

const loadMonth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/screens", () => ({
  getKnitToday: async () => "2026-09-30",
  loadMonth,
}));
vi.mock("@/components/month-calendar", () => ({ MonthCalendar: () => null }));
vi.mock("@/app/(app)/_parts/day-screen", () => ({ DayScreen: () => null }));

const root = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the screens' today", () => {
  afterEach(() => vi.useRealTimers());

  it("no page or component reads today from the process clock", () => {
    const offenders = [
      ...sourceFiles(join(root, "app")),
      ...sourceFiles(join(root, "components")),
    ].filter((file) => /\btodayIST\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the calendar opens on the database's month, whatever the server clock says", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T06:00:00Z"));
    loadMonth.mockResolvedValue({ today: "2026-09-30", days: [] });
    const { default: CalendarPage } = await import("@/app/(app)/calendar/page");
    const page = await CalendarPage({ searchParams: Promise.resolve({}) });
    expect(loadMonth).toHaveBeenCalledWith("2026-09-01");
    // The selected day below the grid is the database's today too.
    const children = (
      page as { props: { children: { props: Record<string, unknown> }[] } }
    ).props.children;
    expect(children[0]!.props.selected).toBe("2026-09-30");
    expect(children[1]!.props.day).toBe("2026-09-30");
  });
});
