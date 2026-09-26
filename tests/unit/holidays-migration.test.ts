import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// PRD 6.2: the holiday list lives in two places, the fixture Pragaman supplied and the
// migration that loads it into every database. They must never drift apart.
describe("holidays migration", () => {
  it("loads exactly the holidays in fixtures/holidays.json", () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../fixtures/holidays.json", import.meta.url)),
        "utf8",
      ),
    ) as { holidays: { date: string; name: string }[] };

    const dir = fileURLToPath(
      new URL("../../supabase/migrations/", import.meta.url),
    );
    const file = readdirSync(dir).find((name) =>
      name.endsWith("_holidays_2026_27.sql"),
    );
    expect(file).toBeDefined();
    const sql = readFileSync(`${dir}${file}`, "utf8");
    const insert = /insert into public\.holidays[\s\S]*?on conflict/.exec(
      sql,
    )?.[0];
    expect(insert).toBeDefined();
    const loaded = [
      ...insert!.matchAll(/\('(\d{4}-\d{2}-\d{2})', '((?:[^']|'')*)'\)/g),
    ].map(([, date, name]) => ({ date, name: name!.replace(/''/g, "'") }));

    expect(loaded).toEqual(fixture.holidays);
  });
});
