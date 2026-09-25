import { describe, expect, it } from "vitest";

// Guard for PRD 17: "tests run with TZ=UTC to prove IST handling does not
// depend on the machine". If this fails, the date tests prove nothing.
describe("test environment", () => {
  it("runs in UTC whatever the machine's own timezone is", () => {
    expect(["UTC", "Etc/UTC"]).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    expect(new Date(2026, 8, 25, 12).getTimezoneOffset()).toBe(0);
  });
});
