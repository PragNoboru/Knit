import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// PRD 7.3 (audit finding 62): "set maxDuration to the plan's allowed maximum". Knit ships with
// 60 seconds; docs/RUNBOOK.md 2.3 says how to raise it, and must name every place that sets it.

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

function files(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory()
      ? files(path)
      : /\.tsx?$/.test(name)
        ? [path]
        : [];
  });
}

describe("RUNBOOK 2.3: the function time limit", () => {
  const runbook = read("docs/RUNBOOK.md");
  const section = runbook.slice(
    runbook.indexOf("### 2.3 Vercel"),
    runbook.indexOf("### 2.4"),
  );

  it("names every file that sets maxDuration, and the pg_net timeout in cron.sql", () => {
    const setting = files("app")
      .filter((path) => /export const maxDuration = \d+;/.test(read(path)))
      .map((path) => relative(".", path).split(sep).join("/"));
    expect(setting.length).toBeGreaterThanOrEqual(5);
    for (const path of setting) expect(section).toContain(`\`${path}\``);
    expect(section).toContain("`timeout_milliseconds := 60000`");
    expect(section).toContain("`supabase/sql/cron.sql`");
  });

  it("every one of them sets the same value", () => {
    const values = files("app")
      .map((path) => /export const maxDuration = (\d+);/.exec(read(path))?.[1])
      .filter((value): value is string => value !== undefined);
    expect(new Set(values)).toEqual(new Set(["60"]));
    expect(read("supabase/sql/cron.sql")).toContain(
      "timeout_milliseconds := 60000",
    );
  });
});
