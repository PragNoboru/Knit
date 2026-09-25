import { describe, expect, it } from "vitest";

import { findEmDashes, isChecked } from "@/scripts/check-no-em-dash.mjs";

// Built from its code point: Prettier would turn an escape into the character.
const EM_DASH = String.fromCharCode(0x2014);

describe("no em dashes check (CLAUDE.md conventions)", () => {
  it("reports each line that holds an em dash", () => {
    const hits = findEmDashes([
      { path: "docs/RUNBOOK.md", content: `fine\nbad ${EM_DASH} line\nfine` },
      { path: "README.md", content: "all fine: colon, comma · middle dot" },
    ]);
    expect(hits).toEqual([{ path: "docs/RUNBOOK.md", line: 2 }]);
  });

  it("catches escaped em dashes in UI code only", () => {
    const content = 'const copy = "Due today &mdash; 3 tasks";';
    expect(
      findEmDashes([{ path: "components/today.tsx", content }]),
    ).toHaveLength(1);
    expect(
      findEmDashes([{ path: "app/page.tsx", content: "a \\u2014 b" }]),
    ).toHaveLength(1);
    expect(findEmDashes([{ path: "scripts/tool.mjs", content }])).toHaveLength(
      0,
    );
  });

  it("checks text files but skips tracker fixtures and the lockfile", () => {
    expect(isChecked("docs/PRD.md")).toBe(true);
    expect(isChecked("app/(app)/page.tsx")).toBe(true);
    expect(isChecked(".env.example")).toBe(true);
    expect(isChecked("fixtures/trackers.config.json")).toBe(false);
    expect(isChecked("fixtures/trackers/Sapiens_Example_Tracker.xlsx")).toBe(
      false,
    );
    expect(isChecked("pnpm-lock.yaml")).toBe(false);
    expect(isChecked("app/favicon.ico")).toBe(false);
  });
});
