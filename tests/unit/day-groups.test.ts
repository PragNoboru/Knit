import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DayNotice, DayView } from "@/lib/domain/day-view";

// PRD 12.7, N78: the first-run states "Connect your first tracker." and "No trackers are
// connected to your account yet." also offer "Open the Guide" (12.9).

vi.mock("@/components/task-row", () => ({
  TaskRow: () => null,
  TaskRowHeader: () => null,
}));
vi.mock("@/components/pull-forward-button", () => ({
  PullForwardButton: () => null,
}));

const { DayGroups } = await import("@/components/day-groups");

const render = (notice: DayNotice) => {
  const view: DayView = {
    day: "2026-10-05",
    when: "today",
    header: "Mon 5 Oct",
    notice,
    groups: [],
  };
  return renderToStaticMarkup(
    createElement(DayGroups, {
      view,
      today: "2026-10-05",
      drawerHref: (id: string) => `/?task=${id}`,
    }),
  );
};

/** Every link on the page as [href, text]. */
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [
    m[1],
    m[2],
  ]);

describe("the first-run states point to the Guide (N78)", () => {
  it("Connect your first tracker. offers Open Trackers and Open the Guide", () => {
    const html = render({ kind: "no_trackers" });
    expect(html).toContain("Connect your first tracker.");
    expect(links(html)).toEqual([
      ["/admin/trackers", "Open Trackers"],
      ["/guide", "Open the Guide"],
    ]);
  });

  it("No trackers are connected to your account yet. offers Contact the admin and Open the Guide", () => {
    const html = render({
      kind: "no_tasks",
      adminContact: { name: "Pragaman", email: "admin@knit.test" },
    });
    expect(html).toContain("No trackers are connected to your account yet.");
    expect(links(html)).toEqual([
      ["mailto:admin@knit.test", "Contact Pragaman"],
      ["/guide", "Open the Guide"],
    ]);
  });

  it("offers Open the Guide also when no admin can be contacted", () => {
    const html = render({ kind: "no_tasks", adminContact: null });
    expect(links(html)).toEqual([["/guide", "Open the Guide"]]);
  });
});
